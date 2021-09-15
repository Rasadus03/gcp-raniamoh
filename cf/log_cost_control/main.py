import base64
import json
import os
# Imports the Cloud Logging client library
import google.cloud.logging



def turn_off_logs(data, context):
    pubsub_message = data
    # Instantiates a client
    logging_client = google.cloud.logging.Client()

    # Retrieves a Cloud Logging handler based on the environment
    # you're running in and integrates the handler with the
    # Python logging module. By default this captures all logs
    # at INFO level and higher
   # logging_client.get_default_handler()
    #logging_client.setup_logging()

    for loadedSink in logging_client.list_sinks():
        print("Loaded sink name {} ".format(loadedSink.name)) 
        if loadedSink.name == "_Default" :
            sink = loadedSink

    sink.reload()

    sink.filter_ = "severity >= ERROR"
    print("Updated sink {}".format(sink.filter_))
    sink.update(unique_writer_identity=True)