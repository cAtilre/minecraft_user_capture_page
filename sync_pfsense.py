#!/usr/bin/env python3
"""
sync_pfsense.py

Reads logs/players.json (volume-mounted from the Docker host) and ensures
every player's IP address and/or FQDN is present in the pfSense firewall
alias named in sync_pfsense.conf.

Only adds entries — never removes (add-only mode).
FQDNs are pushed as-is; pfSense resolves them to IPs itself.

Usage:
  python3 sync_pfsense.py [--dry-run] [--config /path/to/sync_pfsense.conf]

Cron example (every 5 minutes, run on the Docker host):
  */5 * * * * /usr/bin/python3 /opt/mc_sync/sync_pfsense.py >> /var/log/mc_sync.log 2>&1
"""

import argparse
import configparser
import json
import logging
import os
import sys
from pathlib import Path

import paramiko

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# pfSense PHP script template
#
# ALIAS_NAME_PLACEHOLDER  → replaced with a PHP double-quoted string literal
# ADDRESSES_PLACEHOLDER   → replaced with a PHP single-quoted JSON string
#                           passed to json_decode()
#
# Regular string (not f-string) so PHP's $var and {$var} syntax is safe.
# ---------------------------------------------------------------------------

_PHP_TEMPLATE = r"""<?php
require_once("/etc/inc/globals.inc");
require_once("/etc/inc/functions.inc");
require_once("/etc/inc/config.inc");
require_once("/etc/inc/filter.inc");

global $config;

// Each entry is [address, note_label]
$alias_name  = ALIAS_NAME_PLACEHOLDER;
$new_entries = json_decode(ADDRESSES_PLACEHOLDER, true);

if (!isset($config['aliases']['alias']) || !is_array($config['aliases']['alias'])) {
    fwrite(STDERR, "ERROR: No aliases found in pfSense config.\n");
    exit(1);
}

$found = false;
foreach ($config['aliases']['alias'] as $idx => $alias) {
    if ($alias['name'] !== $alias_name) {
        continue;
    }
    $found = true;

    $raw      = trim($alias['address'] ?? '');
    $existing = ($raw !== '') ? preg_split('/\s+/', $raw) : [];
    $det_raw  = $alias['detail'] ?? '';
    $details  = ($det_raw !== '') ? explode('||', $det_raw) : [];
    $changed  = false;

    foreach ($new_entries as $entry) {
        $addr = $entry[0];
        $note = $entry[1];
        if (!in_array($addr, $existing, true)) {
            $existing[] = $addr;
            $details[]  = $note;
            $changed    = true;
            echo "Added: " . $addr . " (" . $note . ")\n";
        } else {
            echo "Present: " . $addr . " (" . $note . ")\n";
        }
    }

    if ($changed) {
        $config['aliases']['alias'][$idx]['address'] = implode(' ', $existing);
        $config['aliases']['alias'][$idx]['detail']  = implode('||', $details);
        write_config("MinecraftAllows updated by sync_pfsense cron");
        filter_configure();
        echo "Config saved and filter reloaded.\n";
    } else {
        echo "No changes needed.\n";
    }
    break;
}

if (!$found) {
    fwrite(STDERR, "ERROR: Alias '" . $alias_name . "' not found in pfSense config.\n");
    exit(1);
}
"""


def build_php_script(alias_name: str, entries: list) -> str:
    """Inject alias name and [[addr, note], ...] entries into the PHP template safely."""
    # json.dumps produces a double-quoted string literal valid in PHP
    name_literal = json.dumps(alias_name)

    # Encode entries list as JSON, then wrap in a PHP single-quoted string.
    # Only \ and ' need escaping inside PHP single-quoted strings.
    entries_json = json.dumps(entries)
    entries_php  = "'" + entries_json.replace("\\", "\\\\").replace("'", "\\'") + "'"

    script = _PHP_TEMPLATE.replace("ALIAS_NAME_PLACEHOLDER", name_literal)
    script = script.replace("ADDRESSES_PLACEHOLDER", entries_php)
    return script


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config(config_path: str) -> configparser.ConfigParser:
    cfg = configparser.ConfigParser()
    if not Path(config_path).exists():
        log.error("Config file not found: %s", config_path)
        sys.exit(1)
    cfg.read(config_path)
    for section, key in [
        ("pfsense", "host"),
        ("pfsense", "user"),
        ("pfsense", "ssh_key"),
        ("data",    "json_path"),
    ]:
        if not cfg.has_option(section, key):
            log.error("Missing required config option: [%s] %s", section, key)
            sys.exit(1)
    return cfg


# ---------------------------------------------------------------------------
# Player data
# ---------------------------------------------------------------------------

def load_players(json_path: str) -> dict:
    p = Path(json_path)
    if not p.exists():
        log.warning("players.json not found at %s — nothing to sync.", json_path)
        return {}
    with p.open() as f:
        return json.load(f)


def collect_addresses(players: dict) -> list:
    """
    Return a deduplicated list of (addr, note) tuples.

    - Prefers FQDN over IP: if both are present only the FQDN is used.
    - Note format: "username_realName" when realName differs from username,
      otherwise just "username".
    """
    results = []
    seen = set()
    for username, data in players.items():
        real = (data.get("realName") or "").strip()
        note = f"{username}_{real}" if real and real != username else username

        # Prefer FQDN; fall back to IP
        addr = (data.get("fqdn") or "").strip() or (data.get("ip") or "").strip()
        if addr and addr not in seen:
            results.append((addr, note))
            seen.add(addr)
    return results


# ---------------------------------------------------------------------------
# pfSense SSH sync
# ---------------------------------------------------------------------------

def sync_to_pfsense(
    cfg: configparser.ConfigParser,
    addresses: list,
    dry_run: bool = False,
) -> None:
    host       = cfg["pfsense"]["host"]
    user       = cfg["pfsense"]["user"]
    key_path   = os.path.expanduser(cfg["pfsense"]["ssh_key"])
    known_hosts = os.path.expanduser(cfg["pfsense"].get("known_hosts", ""))
    port       = int(cfg["pfsense"].get("port", "22"))
    alias_name = cfg["pfsense"].get("alias_name", "MinecraftAllows")
    remote_tmp = cfg["pfsense"].get("remote_tmp", "/tmp/.mc_alias_sync.php")

    entries = [[addr, note] for addr, note in addresses]
    php = build_php_script(alias_name, entries)

    if dry_run:
        log.info("[DRY RUN] Would connect to pfSense at %s:%s", host, port)
        log.info("[DRY RUN] Would push %d address(es) to alias '%s'",
                 len(entries), alias_name)
        log.info("[DRY RUN] Generated PHP script:\n%s", php)
        return

    client = paramiko.SSHClient()
    if known_hosts and Path(known_hosts).exists():
        client.load_host_keys(known_hosts)
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        log.warning(
            "known_hosts not configured or file not found — using TOFU (AutoAddPolicy). "
            "Set [pfsense] known_hosts in your config for ongoing use."
        )
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            hostname=host,
            port=port,
            username=user,
            key_filename=key_path,
            timeout=30,
            look_for_keys=False,
            allow_agent=False,
        )
        log.info("Connected to pfSense at %s:%s as %s", host, port, user)

        # Upload PHP script via SFTP
        sftp = client.open_sftp()
        with sftp.open(remote_tmp, "w") as fh:
            fh.write(php)
        sftp.close()

        # Execute, then always clean up the temp file
        cmd = f"php {remote_tmp}; _rc=$?; rm -f {remote_tmp}; exit $_rc"
        _, stdout, stderr = client.exec_command(cmd, timeout=120)
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        rc  = stdout.channel.recv_exit_status()

        for line in out.splitlines():
            log.info("pfSense | %s", line)
        for line in err.splitlines():
            (log.error if rc != 0 else log.warning)("pfSense ERR | %s", line)

        if rc != 0:
            log.error("Remote PHP script exited with code %d", rc)
            sys.exit(rc)

    finally:
        client.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    default_config = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "sync_pfsense.conf"
    )
    parser = argparse.ArgumentParser(
        description="Sync players.json to a pfSense firewall alias"
    )
    parser.add_argument(
        "--config",
        default=default_config,
        help="Path to config file (default: sync_pfsense.conf next to this script)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without connecting to pfSense",
    )
    args = parser.parse_args()

    cfg     = load_config(args.config)
    players = load_players(cfg["data"]["json_path"])

    if not players:
        log.info("No players found — nothing to sync.")
        return

    addresses = collect_addresses(players)
    if not addresses:
        log.info("No IP / FQDN entries found in player records — nothing to sync.")
        return

    log.info(
        "Syncing %d unique address(es) from %d player record(s) to pfSense...",
        len(addresses), len(players),
    )
    for addr, note in addresses:
        log.info("  %-40s  note=%s", addr, note)

    sync_to_pfsense(cfg, addresses, dry_run=args.dry_run)
    log.info("Sync complete.")


if __name__ == "__main__":
    main()
