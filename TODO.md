# Project TODO

## Oracle Cloud + Fyers API setup (active)

- [ ] 1. Generate OCI API key pair locally (`~/.oci/oci_api_key.pem` + public key) — DONE
- [ ] 2. Upload public key to OCI Console, capture fingerprint — DONE
- [ ] 3. Write `~/.oci/config` (user, tenancy, fingerprint, region=ap-tokyo-1, key_file) — DONE
- [ ] 4. Install `oci-cli` and verify CLI auth against tenancy in ap-tokyo-1 — DONE
- [ ] 5. List existing VCNs/subnets/reserved IPs/instances in ap-tokyo-1 (full scratch assumed) — PENDING
- [ ] 6. Create VCN + regional subnet in ap-tokyo-1 (if none exist) — PENDING
- [ ] 7. Create security list / NSG: allow SSH (22) + callback port from Cloudflare IPs or 0.0.0.0/0 — PENDING
- [ ] 8. Reserve a static public IP in ap-tokyo-1 — PENDING
- [ ] 9. Generate SSH key pair for the VM (`~/.ssh/oci-fyers-id_ed25519`) — PENDING
- [ ] 10. Launch `VM.Standard.A1.Flex` ARM Ampere Always-Free VM in the subnet, attach reserved IP, inject SSH key — PENDING
- [ ] 11. Install Node.js callback server on the VM (Express/Fastify) listening on the callback port — PENDING
- [ ] 12. Start the callback server as a service / nohup so it survives — PENDING
- [ ] 13. Configure Cloudflare DNS for berhampore.in: A/AAAA record pointing at the Oracle static IP, proxy ON — PENDING
- [ ] 14. Report the exact redirect URI string for Fyers app registration (`https://<host>/callback`) — PENDING

## Cloudflare credentials

- [x] 15. Store Cloudflare API token in project `.env` as `CLOUDFLARE_API_TOKEN` — DONE (value received: cfk_...6qCf69868e6)
- [ ] 16. Discover `CLOUDFLARE_ZONE_ID` for berhampore.in from the token and store in `.env` — PENDING

## FYERS API key setup

- [ ] 17. User provides `FYERS_APP_ID` and/or valid `FYERS_ACCESS_TOKEN` — PENDING (waiting for user)
- [ ] 18. Store FYERS credentials in project `.env` (`FYERS_APP_ID`, `FYERS_ACCESS_TOKEN`) — PENDING
- [ ] 19. Confirm whether Fyers app registration needs recreating or can reuse existing app — PENDING (waiting for user)

## Git sync

- [ ] 20. Review staged/modified files, ensure credentials are in `.env` (tracked, private repo) and nowhere else unsafe — PENDING
- [ ] 21. Commit on `dev`, pull --rebase, push origin/dev — PENDING

## Sandbox trade runner

- [ ] 22. Fix and run `/home/swarna-sekhar-dhar/projects/my-job-agent/scripts/sandbox-trade-runner.ts` — PENDING (from prior session, resume after OCI/Fyers setup if still desired)
