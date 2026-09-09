# Dashboard

The web panel. Node, server-rendered HTML, no client framework, no external
assets — the CSP blocks them, and a panel that can grant SSH access is the last
place to be pulling scripts off a CDN.

Architecture, security model and deployment: see the [repository README](../README.md)
and [docs/agents.md](../docs/agents.md).

## Layout

    server.js              routes, auth, sessions, CSRF
    lib/db.js              SQLite: admin account, pairing codes, devices, login log
    lib/priv.js            wrapper that shells out to the privileged helper
    lib/ui.js              shared page chrome and formatting
    lib/views.js           system pages (overview, keys, devices, audit)
    lib/views-agents.js    agent management pages
    lib/views-guide.js     the operator's manual, served from the panel
    lib/telegram.js        Bot API client, used only to validate configuration
    public/style.css       styles
    public/app.js          confirmations + live stat refresh

    deploy/moni-helper             privileged helper -> /usr/local/sbin/
    deploy/moni-agent@.service     systemd template, one instance per agent
    deploy/moni-dashboard.service  systemd unit for this panel
    deploy/nginx-moni.conf         nginx site
    deploy/moni-proxy-params       shared proxy headers
    deploy/moni-sudoers            the single-command sudo rule
    deploy/fail2ban-*.conf         filter and jail

## Deploying a change

    sudo bash /opt/moni-ai-os/deploy/deploy-dashboard.sh

It syntax-checks every file before restarting. Doing it by hand instead, always
`node --check` first — a syntax error otherwise leaves the service in a restart
loop with the panel down.
