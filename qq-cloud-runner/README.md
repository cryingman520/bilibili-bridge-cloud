# QQ Companion cloud runner

Node.js 22+, no runtime dependencies. Implements QQ official HTTPS webhook signature validation and durable queued replies. This is an independent QQ API service, not the current ChatGPT conversation or a hosted DSH desktop.

Start: `node qq-cloud-runner/server.mjs` from repository root. Tests: `node --test qq-cloud-runner/engine.test.mjs`.

Required runtime secrets: `SITE_URL`, `SITE_SERVICE_TOKEN`, `RUNNER_KEY`. Obtain the service token through the owner-private Site's supported service access. Never commit their values. Configure the model key and QQ AppID/AppSecret through the private management page.

Configure QQ's HTTPS callback to `https://YOUR-SERVICE.onrender.com/qq/webhook`, subscribe to `C2C_MESSAGE_CREATE` and `GROUP_AT_MESSAGE_CREATE`, and set the QQ platform's required IP allowlist to the service's actual outbound addresses. Callback validation requires saved QQ credentials. Enable the bot only after credential checks and callback configuration.

Render: region Singapore, Node runtime, build `node --check qq-cloud-runner/server.mjs`, start `node qq-cloud-runner/server.mjs`, health `/health`. The proposed non-sleeping plan is `0.5c-512mb` ($7/month as checked 2026-10-26), excluding model usage, bandwidth overages and taxes. The Free plan sleeps and is not an always-on deployment.

No automatic resend occurs after an ambiguous QQ send or expired processing lease. Inspect the job and the actual QQ conversation before a user-authorized new send. Long-term facts are stored per contact in Sites D1; `/记住 内容` writes explicitly and `/忘记全部` deletes that conversation's memory. Optional extraction runs every five user messages using the configured model and can be disabled. Memory is retrieval, not model training, and can be wrong.

Phase one supports text, persona, memory, manual messages and one-off reminders. Voice, image recognition and QQ personal-account/Qzone features are not included.
