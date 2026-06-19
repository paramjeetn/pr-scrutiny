export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Scrutiny — AI Code Review for GitHub</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 0; }

    /* Hero */
    .hero { max-width: 760px; margin: 0 auto; padding: 80px 24px 60px; text-align: center; }
    .badge { display: inline-block; background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 4px 14px; font-size: 12px; color: #7d8590; margin-bottom: 24px; letter-spacing: 0.5px; }
    h1 { font-size: clamp(32px, 5vw, 52px); font-weight: 700; margin: 0 0 16px; line-height: 1.15; }
    h1 span { background: linear-gradient(135deg, #58a6ff, #a371f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .tagline { font-size: 18px; color: #8b949e; margin: 0 0 36px; line-height: 1.6; max-width: 520px; margin-left: auto; margin-right: auto; }
    .cta { display: inline-flex; align-items: center; gap: 8px; background: #238636; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; transition: background 0.15s; }
    .cta:hover { background: #2ea043; }
    .cta-icon { font-size: 18px; }

    /* Divider */
    .divider { border: none; border-top: 1px solid #21262d; margin: 0; }

    /* Commands section */
    .section { max-width: 760px; margin: 0 auto; padding: 56px 24px; }
    .section-label { font-size: 12px; font-weight: 600; color: #58a6ff; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 10px; }
    h2 { font-size: 26px; font-weight: 700; margin: 0 0 32px; }
    .commands { display: grid; gap: 12px; }
    .cmd { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 20px; display: flex; align-items: flex-start; gap: 16px; transition: border-color 0.15s; }
    .cmd:hover { border-color: #30363d; }
    .cmd-pill { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 13px; color: #58a6ff; white-space: nowrap; flex-shrink: 0; margin-top: 1px; }
    .cmd-text strong { display: block; font-size: 14px; color: #e6edf3; margin-bottom: 2px; }
    .cmd-text span { font-size: 13px; color: #7d8590; line-height: 1.5; }

    /* How it works */
    .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-top: 32px; }
    .step { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 24px 20px; }
    .step-num { width: 28px; height: 28px; background: #1f3a5e; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #58a6ff; margin-bottom: 14px; }
    .step strong { display: block; font-size: 14px; margin-bottom: 6px; }
    .step span { font-size: 13px; color: #7d8590; line-height: 1.5; }

    /* Severity */
    .severity { display: grid; gap: 10px; margin-top: 32px; }
    .sev { display: flex; align-items: center; gap: 14px; background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 16px; }
    .sev-tag { font-size: 12px; font-weight: 700; font-family: monospace; padding: 2px 8px; border-radius: 4px; min-width: 68px; text-align: center; }
    .hold { background: #3d1414; color: #f85149; border: 1px solid #6e2020; }
    .warn { background: #2d2000; color: #d29922; border: 1px solid #4d3800; }
    .suggest { background: #0c2d6b; color: #58a6ff; border: 1px solid #1158c7; }
    .pass { background: #0f2d1a; color: #3fb950; border: 1px solid #1a4d2a; }
    .question { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
    .sev span { font-size: 13px; color: #7d8590; }

    /* Footer */
    footer { border-top: 1px solid #21262d; padding: 28px 24px; text-align: center; font-size: 13px; color: #484f58; }
    footer a { color: #58a6ff; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>

  <div class="hero">
    <div class="badge">GitHub App</div>
    <h1>Code review that actually<br><span>digs deeper</span></h1>
    <p class="tagline">PR Scrutiny runs parallel specialist agents on every pull request — security, quality, blast radius, and AI summary — and posts structured comments directly on your PR.</p>
    <a class="cta" href="https://github.com/apps/pr-scrutiny/installations/new">
      <span class="cta-icon">⊕</span> Install on GitHub
    </a>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-label">Slash Commands</div>
    <h2>Summon a review anytime</h2>
    <div class="commands">
      <div class="cmd">
        <div class="cmd-pill">/review</div>
        <div class="cmd-text">
          <strong>Full review</strong>
          <span>Security + code quality + blast radius + AI summary. The works.</span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/review:security</div>
        <div class="cmd-text">
          <strong>Security scan</strong>
          <span>Hardcoded secrets, injection sinks, missing auth, dependency CVEs.</span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/review:perf</div>
        <div class="cmd-text">
          <strong>Code quality</strong>
          <span>N+1 queries, complexity hotspots, missing test coverage, performance anti-patterns.</span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/blast-radius</div>
        <div class="cmd-text">
          <strong>Blast radius</strong>
          <span>What else could break? Affected files, routes, config changes, test gaps.</span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/summarize</div>
        <div class="cmd-text">
          <strong>AI summary</strong>
          <span>Plain-English explanation of what this PR actually does and why.</span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/ask &lt;question&gt;</div>
        <div class="cmd-text">
          <strong>Ask anything</strong>
          <span>Ask a specific question about the diff. <em>/ask is this auth change backward compatible?</em></span>
        </div>
      </div>
      <div class="cmd">
        <div class="cmd-pill">/re-review</div>
        <div class="cmd-text">
          <strong>Re-review</strong>
          <span>Re-run the full review after you've pushed fixes.</span>
        </div>
      </div>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-label">How it works</div>
    <h2>From PR to review in under a minute</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <strong>PR opens or you type a command</strong>
        <span>Auto-triggers on new PRs, or summon it manually with a slash command.</span>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <strong>Agents run in parallel</strong>
        <span>Security, Quality, Blast Radius, and LLM agents each analyse one dimension simultaneously.</span>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <strong>Results posted to your PR</strong>
        <span>Inline comments on specific lines, summary with severity breakdown, and an AI explanation.</span>
      </div>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-label">Severity levels</div>
    <h2>Clear, actionable signals</h2>
    <div class="severity">
      <div class="sev"><span class="sev-tag hold">HOLD</span><span>Blocking issue — merge only after fixing this.</span></div>
      <div class="sev"><span class="sev-tag warn">WARN</span><span>Likely bug or risk — review carefully before merging.</span></div>
      <div class="sev"><span class="sev-tag suggest">SUGGEST</span><span>Improvement suggestion — optional but worth considering.</span></div>
      <div class="sev"><span class="sev-tag pass">PASS</span><span>Looks good.</span></div>
      <div class="sev"><span class="sev-tag question">QUESTION</span><span>Clarification needed from the author.</span></div>
    </div>
  </div>

  <hr class="divider">

  <footer>
    Built by <a href="https://github.com/paramjeetn">@paramjeetn</a> &nbsp;·&nbsp;
    <a href="https://github.com/apps/pr-scrutiny/installations/new">Install the app</a> &nbsp;·&nbsp;
    <a href="https://github.com/paramjeetn/pr-scrutiny">View source</a>
  </footer>

</body>
</html>`
}
