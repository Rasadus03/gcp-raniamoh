# agents.py
import os
from google.adk.agents import Agent
from google.adk.tools import  FunctionTool,AgentTool
from google.adk.tools.mcp_tool import MCPToolset
from google.adk.tools.mcp_tool.mcp_toolset   import StreamableHTTPConnectionParams
from google.adk.agents.readonly_context import ReadonlyContext
from google.oauth2 import id_token
from google.auth.transport import requests as google_auth_requests
from . import tools
from google.adk.agents.remote_a2a_agent import AGENT_CARD_WELL_KNOWN_PATH
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent
import httpx

from a2a.client import A2ACardResolver, A2AClient
from a2a.types import (
    AgentCard,
    MessageSendParams,
    SendMessageRequest,
    SendStreamingMessageRequest,
)
from a2a.utils.constants import (
    AGENT_CARD_WELL_KNOWN_PATH,
    EXTENDED_AGENT_CARD_PATH,
)
from uuid import uuid4

from typing import Any

logistics_agent_url = os.environ.get("LOGISTICS_AGENT_URL") 
logistics_client = None
resolver = None
final_agent_card_to_use: AgentCard | None = None
MCP_TOOLBOX_URL = os.environ.get("MCP_TOOLBOX_URL")
if not MCP_TOOLBOX_URL:
    raise ValueError("MCP_TOOLBOX_URL environment variable not set.")

# MCP Toolset instance to connect to the deployed MCP Toolbox
mcp_toolset = MCPToolset(
    connection_params=StreamableHTTPConnectionParams(url=MCP_TOOLBOX_URL + "/mcp"), # Standard MCP endpoint
   # header_provider=mcp_header_provider,
    tool_filter=["search_product_by_name", "check_product_inventory", "get_related_products"] # Optional: Filter to specific tools
)
# 1. Logistic Agent, A2A client and tool and the agent definition:
async def send_request_to_logistics_agent(text_request: str)-> dict:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as httpx_client:
        # Initialize A2ACardResolver
        resolver = A2ACardResolver(
            httpx_client=httpx_client,
            base_url=logistics_agent_url,
            # agent_card_path uses default, extended_agent_card_path also uses default
        )
        try:
            _public_card = (
                await resolver.get_agent_card()
            )  # Fetches from default public path
            
            final_agent_card_to_use = _public_card
            print (f"final_agent_card_to_use= {final_agent_card_to_use}")
             # supports_authenticated_extended_card is False or None
            print(
                    '\nPublic card does not indicate support for an extended card. Using public card.'
                )

        except Exception as e:
            print(
                f'Critical error fetching public agent card: {e}', exc_info=True
            )
            raise RuntimeError(
                'Failed to fetch the public agent card. Cannot continue.'
            ) from e

        logistics_client = A2AClient(
                httpx_client=httpx_client, agent_card=final_agent_card_to_use
            )
        print('A2AClient initialized.')
        send_message_payload: dict[str, Any] = {
                'message': {
                    'role': 'user',
                    'parts': [
                        {'kind': 'text', 'text': text_request }
                    ],
                    'messageId': uuid4().hex,
                },
            }
        print('Payload created.')
        request = SendMessageRequest(
            id=str(uuid4()), params=MessageSendParams(**send_message_payload)
        )
        print('Request created.')
        response = await logistics_client.send_message(request);
        print('response recieved.')
        print(response.model_dump(mode='json', exclude_none=True))
        return response.model_dump(mode='json', exclude_none=True)
# Logistics Agent tool
send_request_to_logistics_agent_tool = FunctionTool(send_request_to_logistics_agent)

# Logistic Agent
logistics_agent = Agent(
    model="gemini-2.5-flash",
    name="LogisticsAgent",
    description="Handles Shipment estimation, booking and tracking using A2AClient to another Agent.",
    instruction="Use send_request_to_logistics_agent_tool to estimate a shipment, book a shipment or track a shipment" \
      "  All requests must include the text request to show if it is an estimate or booking or tracking and the request must also include json following the agent card," \
        " ask the user for the zip and the weight of the package and also the lenght width and height and prepare the request accordingly.",
    tools=[send_request_to_logistics_agent_tool]
)
# 2. Order Agent, mcp_toolbox_tools for order querying and API function tool for order placement:
#query tools
order_tools = MCPToolset(
    connection_params=StreamableHTTPConnectionParams(url=MCP_TOOLBOX_URL + "/mcp"), # Standard MCP endpoint
   # header_provider=mcp_header_provider,
    tool_filter=["list_user_orders", "get_order_status"] # Optional: Filter to specific tools
)
# function tool
order_placement_tool = FunctionTool(tools.call_place_order_api)
#Order Agent, which includes instruction for creation the json to the API
order_agent = Agent(
    model="gemini-2.5-flash",
    name="OrderAgent",
    description="Handles order placement and status checks using the MCP Toolbox.",
    instruction="Use the list_user_orders to query all user orders and use get_order_status to check status of customer orders. " \
                "Use order_placement_tool to pace a new order for the customer and create a the playload as a JSON following the below example, please use customer email for the customer_id:" \
                " {" \
                " \"customer_id\": \"CUST67890\"," \
                "\"items\": [ " \
                "{ \"product_id\": \"PROD001\", " \
                "\"quantity\": 1 } , " \
                " { \"product_id\": \"PROD002\"," \
                " \"quantity\": 5}," \
                "{\"product_id\": \"PRODAAB\"," \
                "\"quantity\": 1}" \
                "]" \
                "} ",
    tools=[order_tools, order_placement_tool]
)

    
# 3. Specialist Agents now use the MCP Toolset for Search, Inventory and recommendations Agents
search_agent = Agent(
    model="gemini-2.5-flash", name="ProductSearchAgent",
    description="Searches for products using the Retail DB MCP Service.",
    tools=[mcp_toolset]
)
inventory_agent = Agent(
    model="gemini-2.5-flash", name="InventoryAgent",
    description="Checks product inventory using the Retail DB MCP Service.",
    tools=[mcp_toolset]
)
recommendation_agent = Agent(
    model="gemini-2.5-flash", name="RecommendationAgent",
    description="Provides product recommendations using the Retail DB MCP Service.",
    tools=[mcp_toolset]
)
print(f"mcptoobox = {MCP_TOOLBOX_URL}")
# 4. Orchestrator Agent - Instructions are key to guide tool use
root_agent = Agent(
    model="gemini-2.5-pro",
    name="RetailOrchestrator",
    description="Main assistant for retail customer queries, using the MCP Toolbox for DB access.",
    instruction="""Your goal is to help customers find products, check stock, and get recommendations.
    You MUST use the provided tools to interact with the database via the MCP service.

    1.  To find a product, use the 'search_product_by_name' tool. Extract the product_id.
    2.  To check inventory, use the 'check_product_inventory' tool with the product_id.
    3.  To get recommendations, use the 'get_related_products' tool with the product_id.
    4.  For placing or checking orders, use OrderAgent, please always ask for the email to use it as customer_id.
    5.  For Shipment cost estimation, booking and tracking, use the logistics_agent, please ask the user for the zip and 
        the weight of the package and also the lenght width and height.
    Synthesize the information into a single, helpful response.

    Example tool call for search:
    Tool: search_product_by_name
    Params: {"query": "customer query here"}

    Example tool call for inventory:
    Tool: check_product_inventory
    Params: {"product_id": "SKU123"}
    """,
    tools=[
        AgentTool(agent=search_agent),
        AgentTool(agent=inventory_agent),
        AgentTool(agent=recommendation_agent),
        AgentTool(agent=order_agent),
        AgentTool(agent=logistics_agent),
    ]
)
