Brush-Up List
1. Google ADK Core
LlmAgent — how to define system prompt, tools, output schema
BaseAgent (custom) — subclassing, implementing _run_async_impl, working with InvocationContext
ParallelAgent — how it runs sub-agents simultaneously, how session state is shared/merged
SequentialAgent — wiring agents in order
Session state — reading/writing context.session.state between agents
2. Pydantic Structured Outputs in ADK
Defining BaseModel schemas with Literal types
Passing a Pydantic schema to LlmAgent as output_schema
How ADK enforces structured JSON output from the LLM
3. GitHub REST API
Auth header with GITHUB_TOKEN
GET /repos/{owner}/{repo}/pulls/{pr_number}/files — returns file list + patch (unified diff)
GET /repos/{owner}/{repo}/pulls/{pr_number} — PR metadata
POST /repos/{owner}/{repo}/issues/{pr_number}/comments — posting review comment
Parsing a GitHub PR URL to extract owner, repo, pr_number
4. Unified Diff Format
What patch field actually looks like (@@ hunks, +/- lines)
How to extract line numbers from hunk headers — specialists need to cite file:line
5. Python Async
async def, await, asyncio.run()
ADK is async-first; custom agents must be async
6. python-dotenv + config pattern
Loading .env vars at startup
config.yaml for non-secret config
Priority order: ADK session state + BaseAgent → ParallelAgent → Pydantic output_schema → GitHub API. Everything else you can look up as needed.