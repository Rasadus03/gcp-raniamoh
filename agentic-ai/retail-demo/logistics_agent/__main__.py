import asyncio
import functools
import os

import click
import uvicorn

from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import DatabaseTaskStore, InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
)
from agent import root_agent as logistics_agent
from agent_executor import LogisticsAgentExecutor
from dotenv import load_dotenv
from starlette.applications import Starlette


load_dotenv()


class MissingAPIKeyError(Exception):
    """Exception for missing API key."""


def make_sync(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return asyncio.run(func(*args, **kwargs))

    return wrapper


@click.command()
@click.option('--host', default='localhost')
@click.option('--port', default=10002)
@make_sync
async def main(host, port):
    task_store = InMemoryTaskStore()
    agent_card = AgentCard(
        name=logistics_agent.name,
        description=logistics_agent.description,
        version='1.0.0',
        url=os.environ['APP_URL'],
        default_input_modes=['text', 'text/plain'],
        default_output_modes=['text', 'text/plain'],
        capabilities=AgentCapabilities(streaming=True),
        skills=[
            AgentSkill(
                id='get_shipping_rates',
                name='get_shipping_rates',
                description='Get shipping rates for a package.',
                tags=['shippment', 'estimate', 'create'],
                examples=[
                    'Estimate for me the cost of a shipment with the following details:'
                    ' {"weight_kg": 1, "dimensions_cm": { "length": 10, "width": 11, "height": 9}, "origin_zip": "12355","dest_zip": "89763"}']),
            AgentSkill(
                id='book_shipment',
                name='book_shipment',
                description='Book a shipment.',
                tags=['shippment', 'book', 'create'],
                examples=[
                    'Book the shipment for me here is the selected rate and the shippment details:'
                    ' {"weight_kg": 1, "dimensions_cm": { "length": 10, "width": 11, "height": 9}, "origin_zip": "12355","dest_zip": "89763", "rate_id": 13455}']
            ),
            AgentSkill(
                id='track_shipment',
                name='track_shipment',
                description='Track an existing shipment.',
                tags=['shippment', 'track', 'create'],
                examples=[
                    'Track my shipment, here is the tracking id:'
                    ' {"tracking_number": 1}'])
        ],
    )

    
    request_handler = DefaultRequestHandler(
        agent_executor=LogisticsAgentExecutor(
            agent=logistics_agent,
        ),
        task_store=task_store,
    )

    a2a_app = A2AStarletteApplication(
        agent_card=agent_card, http_handler=request_handler
    )
    routes = a2a_app.routes()
    app = Starlette(
        routes=routes,
        middleware=[],
    )

    config = uvicorn.Config(app, host=host, port=port, log_level='info')
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == '__main__':
    main()