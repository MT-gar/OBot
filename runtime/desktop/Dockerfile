# P0 reference runtime. Lock a verified digest before a public release.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=
# Bootstrap public CA roots from the official Node runtime before HTTPS apt.
# Package authentication remains Debian's signed Release/keyring validation.
RUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n')+'\n');const m=process.env.APT_MIRROR;if(m){if(!m.startsWith('https://'))throw Error('APT_MIRROR must use HTTPS');const p='/etc/apt/sources.list.d/debian.sources';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('http://deb.debian.org',m.replace(/\/$/,'')));}" \
 && apt-get -o Acquire::Retries=2 update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini gosu python3 \
      xvfb x11vnc novnc websockify openbox xdotool x11-utils xterm \
      chromium chromium-sandbox dbus-x11 imagemagick \
      fonts-noto-cjk fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1100 desktop \
 && useradd --uid 1100 --gid desktop --create-home --shell /bin/bash desktop

WORKDIR /opt/private-computer
RUN groupadd --gid 1200 runner \
 && useradd --uid 1200 --gid runner --create-home --shell /bin/bash runner
COPY package.json ./
COPY apps ./apps
COPY scripts ./scripts
COPY runtime/desktop/entrypoint.sh runtime/desktop/session.sh /usr/local/lib/private-computer/
RUN chmod 755 /usr/local/lib/private-computer/*.sh

ENV DISPLAY=:99 \
    HOME=/home/desktop \
    USER=desktop \
    APP_HOST=0.0.0.0 \
    APP_PORT=3180 \
    APP_ORIGIN=http://localhost:3180 \
    WORKSPACE_DIR=/home/desktop/Workspace \
    DATA_DIR=/home/desktop/.private-computer \
    NOVNC_DIR=/usr/share/novnc \
    VNC_WS_PORT=6081 \
    BROWSER_CDP_URL=http://127.0.0.1:9222 \
    BROWSER_SANDBOX_ENABLED=true

EXPOSE 3180
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=6 \
  CMD node scripts/healthcheck.mjs
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/private-computer/entrypoint.sh"]
