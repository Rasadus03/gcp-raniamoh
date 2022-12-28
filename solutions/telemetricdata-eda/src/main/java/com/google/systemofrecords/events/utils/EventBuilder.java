package com.google.systemofrecords.events.utils;

import com.google.gson.Gson;
import com.google.protobuf.Any;
import com.google.protobuf.Timestamp;
import com.google.protobuf.util.Timestamps;
import com.google.systemofrecords.events.model.TelemetricDataEvent;
import io.cloudevents.v1.proto.CloudEvent;
import io.cloudevents.v1.proto.CloudEvent.CloudEventAttributeValue;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

public class EventBuilder {

  private static Gson gson = new Gson();
  private static Random rand = new Random();

  public static Any generateTelemetricDataEvent(TelemetricDataEvent telemetricDataEvent) {
    String id = rand.nextLong(100000) + "";
    Timestamp time = Timestamps.fromMillis(telemetricDataEvent.getEventTime().getTime());
    Map<String, CloudEvent.CloudEventAttributeValue> attributes = new HashMap<>();
    attributes.put("datacontenttype",
        CloudEventAttributeValue.newBuilder()
            .setCeString("application/json")
            .build());
    attributes.put("time", CloudEventAttributeValue.newBuilder()
        .setCeTimestamp(time)
        .build());
    attributes.put("vehicleid",
        CloudEventAttributeValue.newBuilder()
            .setCeString(telemetricDataEvent.getVehicleID())
            .build());
    attributes.put("group",
        CloudEventAttributeValue.newBuilder()
            .setCeString("vehicles")
            .build());
    CloudEvent event = CloudEvent.newBuilder()
        .setId(id)
        .setSource(telemetricDataEvent.getEventSource())
        .setType(telemetricDataEvent.getEventType())
        // Eventarc expects 1.0 version
        .setSpecVersion("1.0")
        // Eventarc expects datacontenttype to be application/json
        .putAllAttributes(attributes)
            .setTextData(gson.toJson(telemetricDataEvent.getEventDetails()))
        .build();
    Any wrappedMessage = Any.pack(event);
    java.lang.System.out.println(event);
    return wrappedMessage;
  }

}
