# Nginx Configuration for Reverse Proxy

When using nginx as a reverse proxy in front of your webapp container, configure it to forward the client IP using the `X-Forwarded-For` header.

## Example Nginx Config

Add this to your nginx configuration (e.g., `/etc/nginx/conf.d/username-logger.conf`):

```nginx
upstream webapp {
    server webapp_container:8080;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://webapp;
        
        # Forward original client IP
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header Connection "";
    }
}
```

## Key Headers

- **`X-Forwarded-For`**: Contains the original client IP (what nginx receives from pfsense)
- **`X-Forwarded-Proto`**: HTTP or HTTPS
- **`X-Forwarded-Host`**: Original host name from client request

## Docker Compose Example

If using Docker Compose, your setup might look like:

```yaml
version: '3'
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - webapp
    networks:
      - app-network

  webapp:
    image: username-logger:latest
    networks:
      - app-network
    volumes:
      - ./logs:/app/logs

networks:
  app-network:
    driver: bridge
```

## Docker Stack (Swarm) Example

If using Docker Stack/Swarm:

```yaml
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - app-network

  webapp:
    image: username-logger:latest
    networks:
      - app-network
    volumes:
      - ./logs:/app/logs

networks:
  app-network:
    driver: overlay
```

## Testing

After updating your configuration:

1. Rebuild the docker image:
   ```bash
   docker build -t username-logger .
   ```

2. Deploy/restart your services

3. Submit a test username on your form

4. Check the logs:
   ```bash
   tail -f logs/access.log
   ```

You should now see your actual public IP (from pfsense) instead of the internal Docker IP (10.0.0.x).

## Troubleshooting

If you're still seeing internal IPs:

1. **Verify nginx is forwarding headers**: Check your nginx logs
   ```bash
   docker logs nginx_container_name
   ```

2. **Confirm header is being sent**:
   ```bash
   curl -H "X-Forwarded-For: 192.168.1.100" http://localhost:8080/submit
   ```

3. **Check Express is trusting the proxy**: The app now has `app.set('trust proxy', true)` which tells Express to trust the `X-Forwarded-For` header.
