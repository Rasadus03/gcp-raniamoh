# Logistics Agent

This project contains a Logistics Agent built with the Google Agent Development Kit (ADK). The agent is designed to be deployed on Google Cloud Run and interacts with other services, it id deployed as an A2A service.

It hosts:
- Agent Card (metadata of the skills offered by the Agent as a remote agent), check for all skills: [Agent Card](agent_card.json)
- A2A Server - typical HTTP server but more support streaming, it is simply a A2AStarletteApplication, this is hosted by the [main class](__main__.py), it is the server hosting the Agent Card.
- Agent Executor: this is the wrapper to the agent and it is the one responsible for recieving the message and passing it to the Agent, it is also controlling the lifecycle of the events for handeled within the agent, for example what to do upon updating the artifact and when to reply back to the client agent, check [Agent Executor](agent_executor.py) for all details.
- Agent for the logictics - note that the agent can act at the same time as standalone agent and a remote agent, check [Agent](agent.py) for all details.

## Prerequisites

Before you begin, ensure you have the following installed and configured:

-   Python 3.8+
-   [Google Cloud SDK](https://cloud.google.com/sdk/install)

## Setup

Follow these steps to set up your local development environment and configure Google Cloud.

### 1. Clone the Repository

```bash
git clone https://github.com/Rasadus03/gcp-raniamoh.git
cd agentic-ai/retail-demo/logistics_agent
```

### 2. Create and Activate a Python Virtual Environment

It's recommended to use a virtual environment to manage project dependencies.

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install Dependencies

The required Python packages are listed in `pyproject.toml`.

```bash
uv sync
```

### 4. Configure Google Cloud

Authenticate with Google Cloud to use Application Default Credentials.

```bash
gcloud auth application-default login
```

### 5. Set Environment Variables

You'll need to export several environment variables. Create a `.env` file in the project root or an `env.sh` script to manage them.

**Important:** Replace placeholder values with your actual credentials and configuration.

```bash
# env.sh

# Google Cloud Project Configuration
export GOOGLE_CLOUD_PROJECT="xxxxx"
export GOOGLE_CLOUD_PROJECT_NUMBER="xxxxx"
export GOOGLE_API_KEY="your_google_api_key" # e.g., AIzaSy...

# OAuth Credentials for the Agent
export OAUTH_CLIENT_ID="your_google_oauth_client_id"
export OAUTH_CLIENT_SECRET="your_google_oauth_client_secret"


Source the script to load the variables into your shell session:

```bash
source env.sh
```

## Deployment

The agent and its dependencies are deployed as Cloud Run services.

### Deploying the `logistics-agent`

This is a dependency for the main agent. Deploy it to Cloud Run.

```bash
gcloud run deploy logistics-agent     --port=8080     --source=.     --allow-unauthenticated     --memory "1Gi"     --region="europe-west4"     --project="${GOOGLE_CLOUD_PROJECT}"     --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT="${$GOOGLE_CLOUD_PROJECT}",GOOGLE_CLOUD_LOCATION="europe-west4",APP_URL="https://logistics-agent-${GOOGLE_CLOUD_PROJECT_NUMBER}.europe-west4.run.app"
```