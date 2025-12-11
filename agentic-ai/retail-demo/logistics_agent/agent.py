import os
from google.adk.agents import Agent
from google.adk.tools import  FunctionTool,AgentTool
from google.adk.tools.mcp_tool import MCPToolset
from google.adk.tools.mcp_tool.mcp_toolset   import StreamableHTTPConnectionParams
from google.adk.agents.readonly_context import ReadonlyContext
from google.oauth2 import id_token
from google.auth.transport import requests as google_auth_requests


async def get_mock_rates(self, params):
        # MOCK IMPLEMENTATION
        print(f"Getting mock rates for: {params}")
        return [
            {"carrier": "DemoCarrier", "service": "Ground", "rate": 12.50, "estimated_delivery": "3-5 days"},
            {"carrier": "DemoCarrier", "service": "Express", "rate": 25.00, "estimated_delivery": "1-2 days"}
        ]

async def mock_book_shipment(self, params):
    # MOCK IMPLEMENTATION
    print(f"Mock booking shipment for: {params}")
    return {
        "tracking_number": "DEMO123456789",
        "label_url": "http://example.com/mock_label.pdf"
    }

async def mock_track_shipment(self, params):
    # MOCK IMPLEMENTATION
    print(f"Mock tracking shipment for: {params}")
    return {
        "status": "In Transit",
        "estimated_delivery": "2025-12-12",
        "history": [
            {"status": "Picked Up", "timestamp": "2025-12-09T10:00:00Z"},
            {"status": "In Transit", "timestamp": "2025-12-09T14:00:00Z"}
        ]
    }
mock_track_shipment_tool = FunctionTool(mock_track_shipment)
mock_book_shipment_tool = FunctionTool(mock_book_shipment)
get_mock_rates_tool = FunctionTool(get_mock_rates)
root_agent = Agent(
    model="gemini-2.5-pro",
    name="LogisticsAgent",
    description="Main assistant for planing and checking shippments for retail orders, using the MCP Toolbox for DB access.",
    instruction="""Your goal is to help customers estimate the cost of the shipment, book it and trace it.
               use mock_track_shipment_tool for tracking a shipment.
               use mock_book_shipment_tool for booking a shipment.
               use get_mock_rates_tool for estimating the cost of a shipment""",
    tools=[mock_track_shipment_tool,mock_book_shipment_tool,get_mock_rates_tool],
)
