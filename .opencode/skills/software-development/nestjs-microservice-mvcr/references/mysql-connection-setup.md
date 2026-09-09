# MySQL Connection Setup (Home → Oracle Cloud)

## Connection Architecture

Two environments connect to the same Oracle Cloud MySQL Database instance:

| Environment | Connection Method | Host | Port |
|-------------|-------------------|------|------|
| **Home (my-job-agent)** | SSH tunnel | `127.0.0.1` | `3307` |
| **Dhargent (trading-agent)** | Direct VCN | `10.0.0.99` | `3306` |

### SSH Tunnel Command (run at startup)

```bash
ssh -N -f \
  -i /home/swarna-sekhar-dhar/.ssh/oci-vm-id_ed25519 \
  -L 127.0.0.1:3307:10.0.0.99:3306 \
  ubuntu@168.110.60.10 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=15
```

**What it does:**
- Local port `127.0.0.1:3307` → forwards to Oracle Cloud VCN IP `10.0.0.99:3306`
- Persistent (`-f`) with keepalive (`-N` for no remote command)
- Uses OCI VM SSH key for authentication

### MySQL Hosts in .env

| Host | .env Value | Purpose |
|------|------------|---------|
| **Home** | `MYSQL_HOST=127.0.0.1` | SSH tunnel endpoint |
| **Dhargent** | `MYSQL_HOST=10.0.0.99` | Direct VCN connection |

### Verifying Connection

```bash
# Check tunnel process running
ps aux | grep 'ssh.*-L.*3307'

# Test MySQL connectivity via tunnel
mysql -h 127.0.0.1 -P 3307 -u mylife -p
```

### sync-env-dhargent.sh Behavior

The sync script explicitly **protects** MySQL connection keys:

```bash
PROTECT_RE='^(MYSQL_HOST|MYSQL_PORT|MYSQL_USER|MYSQL_PASSWORD|DATABASE_NAME|...)'
```

This means:
- `MYSQL_HOST` on Dhargent (`10.0.0.99`) is **never** overwritten by home's `.env`
- Each environment keeps its own connection parameters
- Credentials (password) syncs, connection endpoint stays environment-specific

### Why Two Different Hosts?

- **Dhargent** runs ON Oracle Cloud, so it connects directly via VCN (`10.0.0.99`)
- **Home** runs locally, so it connects via SSH tunnel through the Oracle VM (`168.110.60.10`)
- Both point to the same underlying MySQL Database instance

### Cloudflare Tunnel is Separate

The Cloudflare tunnel (`cloudflared run`) forwards HTTP traffic:
- `berhampore.in` → `localhost:3010` (my-job-agent)
- This is **HTTP only**, NOT MySQL

MySQL uses a dedicated SSH tunnel for secure database access.
