# Copyright 2021 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from flask import Flask, request, Response, jsonify, abort
import logging
from logging.config import dictConfig
import sys
import os
from flask_cors import CORS
# gRPC stuff
from concurrent import futures
import multiprocessing

# Prometheus export setup
from prometheus_flask_exporter import PrometheusMetrics
from py_grpc_prometheus.prometheus_server_interceptor import PromServerInterceptor
from prometheus_client import start_http_server
# OpenTelemetry setup
os.environ["OTEL_PYTHON_FLASK_EXCLUDED_URLS"] = "healthz,metrics"  # set exclusions
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry import trace
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
from opentelemetry.propagate import set_global_textmap
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.propagators.cloud_trace_propagator import (
    CloudTraceFormatPropagator,
)
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import TraceIdRatioBased

# set up logging
dictConfig({
    'version': 1,
    'formatters': {'default': {
        'format': '[%(asctime)s] %(levelname)s in %(module)s: %(message)s',
    }},
    'handlers': {'wsgi': {
        'class': 'logging.StreamHandler',
        'stream': 'ext://sys.stdout',
        'formatter': 'default'
    }},
    'root': {
        'level': 'INFO',
        'handlers': ['wsgi']
    }
})

# get host IP
host_ip = os.getenv("HOST", "0.0.0.0") # in absence of env var, default to 0.0.0.0 (IPv4)

# check to see if tracing enabled and sampling probability
trace_sampling_ratio = 0  # default to not sampling if absence of environment var
if os.getenv("TRACE_SAMPLING_RATIO"):

    try:
        trace_sampling_ratio = float(os.getenv("TRACE_SAMPLING_RATIO"))
    except:
        logging.warning("Invalid trace ratio provided.")  # invalid value? just keep at 0%

# if tracing is desired, set up trace provider / exporter
if trace_sampling_ratio > 0:
    logging.info("Attempting to enable tracing.")

    sampler = TraceIdRatioBased(trace_sampling_ratio)

    # OTEL setup
    set_global_textmap(CloudTraceFormatPropagator())

    tracer_provider = TracerProvider(sampler=sampler)
    cloud_trace_exporter = CloudTraceSpanExporter()
    tracer_provider.add_span_processor(
        # BatchSpanProcessor buffers spans and sends them in batches in a
        # background thread. The default parameters are sensible, but can be
        # tweaked to optimize your performance
        BatchSpanProcessor(cloud_trace_exporter)
    )
    trace.set_tracer_provider(tracer_provider)

    tracer = trace.get_tracer(__name__)
    logging.info("Tracing enabled.")

else:
    logging.info("Tracing disabled.")

# flask setup
app = Flask(__name__)
handler = logging.StreamHandler(sys.stdout)
app.logger.addHandler(handler)
#app.logger.propagate = True
app.config['JSONIFY_PRETTYPRINT_REGULAR'] = True
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()  # enable tracing for Requests
app.config['JSON_AS_ASCII'] = False  # otherwise our emojis get hosed
CORS(app)  # enable CORS
metrics = PrometheusMetrics(app)  # enable Prom metrics






# default HTTP service
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def home(path):
    print('test')
    name =  request.args.get('generateError')
    if name =='404':
      abort(404, description="Resource not found")
    elif name =='403':
          abort(403, description="Permission Error")
    elif name =='5xx':
          abort(500, description="Internal Server Error")
    return "Success", 200, {"Access-Control-Allow-Origin": "*"}

if __name__ == '__main__':

    app.run(
        host=host_ip.strip('[]'), # stripping out the brackets if present
        port=int(os.environ.get('PORT', 8080)),
        debug=True,
        threaded=True)