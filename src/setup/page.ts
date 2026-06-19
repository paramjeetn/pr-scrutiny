import type { InstallationConfig, LLMProvider } from '../types/index.js'
import { PROVIDER_MODELS } from '../types/index.js'

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••'
  return key.slice(0, 7) + '•'.repeat(Math.min(key.length - 11, 16)) + key.slice(-4)
}

function modelOptions(provider: LLMProvider, selectedModel: string): string {
  return PROVIDER_MODELS[provider]
    .map((m) => `<option value="${m}"${m === selectedModel ? ' selected' : ''}>${m}</option>`)
    .join('\n')
}

function allModelData(): string {
  const data: Record<string, string[]> = {}
  for (const [p, models] of Object.entries(PROVIDER_MODELS)) {
    data[p] = models
  }
  return JSON.stringify(data)
}

export function renderSetupPage(opts: {
  installationId: number
  existing?: InstallationConfig | null
  error?: string
  success?: boolean
}): string {
  const { installationId, existing, error, success } = opts

  const provider: LLMProvider = existing?.provider ?? 'openai'
  const model    = existing?.model   ?? PROVIDER_MODELS[provider][0]!
  const email    = existing?.email   ?? ''
  const hasKey   = !!existing?.api_key
  const maskedKey = hasKey ? maskKey(existing!.api_key) : ''

  const providerOptions = (['anthropic', 'openai', 'google'] as LLMProvider[])
    .map((p) => `<option value="${p}"${p === provider ? ' selected' : ''}>${
      p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Google'
    }</option>`)
    .join('\n')

  if (success) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Scrutiny — Setup Complete</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; margin: 0; padding: 40px 16px; color: #1f2328; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; max-width: 480px; margin: 0 auto; padding: 40px 32px; text-align: center; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .check { font-size: 48px; margin: 20px 0 12px; }
    .msg { color: #1a7f37; font-size: 17px; font-weight: 600; margin: 0 0 10px; }
    .sub { color: #656d76; font-size: 14px; margin: 0 0 28px; line-height: 1.6; }
    code { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; padding: 2px 6px; font-size: 13px; color: #1f2328; }
    .update-link { font-size: 13px; color: #0969da; text-decoration: none; }
    .update-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>PR Scrutiny</h1>
    <div class="check">✅</div>
    <p class="msg">You're all set!</p>
    <p class="sub">PR Scrutiny is active on your repos.<br>Type <code>/review</code> on any pull request to get started.</p>
    <a class="update-link" href="/setup?installation_id=${installationId}">Update settings</a>
  </div>
</body>
</html>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Scrutiny — Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; margin: 0; padding: 40px 16px; color: #1f2328; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; max-width: 480px; margin: 0 auto; padding: 32px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .subtitle { color: #656d76; font-size: 14px; margin: 0 0 28px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #1f2328; }
    .hint { font-size: 12px; color: #656d76; margin: 2px 0 10px; }
    select, input[type=text], input[type=email], input[type=password] {
      width: 100%; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px;
      font-size: 14px; line-height: 20px; margin-bottom: 16px; outline: none;
      transition: border-color 0.15s;
    }
    select:focus, input:focus { border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,0.1); }
    button[type=submit] {
      width: 100%; padding: 10px; background: #2da44e; color: #fff; border: none;
      border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 4px;
      transition: background 0.15s;
    }
    button[type=submit]:hover:not(:disabled) { background: #2c974b; }
    button[type=submit]:disabled { background: #94d3a2; cursor: not-allowed; }
    .alert { padding: 12px 16px; border-radius: 6px; font-size: 13px; margin-bottom: 20px; }
    .alert-error { background: #fff0f0; border: 1px solid #ffb8b8; color: #cf222e; }
    .divider { border: none; border-top: 1px solid #d0d7de; margin: 20px 0; }
    .existing-note { font-size: 12px; color: #656d76; margin: -12px 0 16px; }
    .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>PR Scrutiny</h1>
    <p class="subtitle">Installation #${installationId} — configure your LLM provider</p>

    ${error ? `<div class="alert alert-error">${error}</div>` : ''}

    <form method="POST" action="/setup" onsubmit="handleSubmit()">
      <input type="hidden" name="installation_id" value="${installationId}">

      <label for="provider">LLM Provider</label>
      <select id="provider" name="provider" onchange="updateModels(this.value)">
        ${providerOptions}
      </select>

      <label for="model">Model</label>
      <select id="model" name="model">
        ${modelOptions(provider, model)}
      </select>

      <label for="api_key">API Key</label>
      ${hasKey ? `<p class="existing-note">Current key: <code>${maskedKey}</code> — leave blank to keep it</p>` : ''}
      <input type="password" id="api_key" name="api_key"
        placeholder="${
          provider === 'anthropic' ? 'sk-ant-...' :
          provider === 'google'    ? 'AIza...' : 'sk-...'
        }"
        autocomplete="off">

      <label for="email">Email</label>
      <div class="hint">For error alerts (bad key, quota exceeded, provider outage)</div>
      <input type="email" id="email" name="email" value="${email}" required placeholder="you@example.com">

      <hr class="divider">

      <button type="submit" id="submit-btn">${existing ? 'Save changes' : 'Save & Activate'}</button>
    </form>
  </div>

  <script>
    const MODELS = ${allModelData()};
    const placeholders = { anthropic: 'sk-ant-...', openai: 'sk-...', google: 'AIza...' };
    function updateModels(provider) {
      const sel = document.getElementById('model');
      sel.innerHTML = MODELS[provider].map(m => '<option value="' + m + '">' + m + '</option>').join('');
      document.getElementById('api_key').placeholder = placeholders[provider] || '';
    }
    function handleSubmit() {
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Verifying key\u2026';
    }
  </script>
</body>
</html>`
}
