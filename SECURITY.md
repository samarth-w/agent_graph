# Security Policy

## Supported Versions

Security fixes are applied to the latest maintained branch.

## Reporting a Vulnerability

Do not open public issues for suspected security vulnerabilities.

Report privately with:

- Affected component and version
- Reproduction details
- Potential impact
- Any suggested mitigation

The maintainers will acknowledge receipt and follow up with triage status.

## Security Notes

- A2A authentication can be configured via `a2a.authToken`.
- Use `127.0.0.1` or private network boundaries for local deployments.
- Enable HTTPS/TLS at the reverse-proxy or transport layer for network-exposed instances.
