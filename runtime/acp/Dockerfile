# Reuse the verified Linux desktop foundation without replacing its rollback tag.
ARG FOUNDATION_IMAGE=private-computer:mvp
FROM ${FOUNDATION_IMAGE}
RUN npm install --prefix /opt/private-node --no-audit --no-fund node@24.22.3
ENV PATH=/opt/private-node/node_modules/node/bin:$PATH
RUN npm install --prefix /opt/dsh --omit=dev --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.3
WORKDIR /opt/private-computer
COPY apps ./apps
COPY scripts ./scripts
COPY runtime/acp ./runtime/acp
COPY runtime/desktop/entrypoint.sh runtime/desktop/session.sh /usr/local/lib/private-computer/
RUN chmod 755 /usr/local/lib/private-computer/*.sh \
 && node --input-type=module -e "import assert from 'node:assert/strict'; import { readFile, access } from 'node:fs/promises'; assert.equal(process.version, 'v24.22.3'); assert.equal(JSON.parse(await readFile('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json', 'utf8')).version, '0.2.2-rc.3'); await access('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'); await access('/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'); await access('/opt/private-computer/runtime/acp/budget.mjs');"
ENV MODEL_EXECUTOR=dsh-acp \
    DSH_ACP_NODE=/opt/private-node/node_modules/node/bin/node \
    DSH_ACP_ENTRY=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
    DSH_ACP_WORK_ROOT=/run/private-computer/acp
