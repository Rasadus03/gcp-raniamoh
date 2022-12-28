package com.google.systemofrecords.events.model;

import java.util.Date;
import java.util.HashMap;
import java.util.Map;


public class TelemetricDataEvent {
  private Date eventTime;
  private String  eventType;
  private  String vehicleID;
  private String eventSource;
  private String eventDetails;


  public TelemetricDataEvent(Date eventTime, String eventType, String vehicleID,
      String eventSource, String eventDetails) {
    this.eventTime = eventTime;
    this.eventType = eventType;
    this.vehicleID = vehicleID;
    this.eventSource = eventSource;
    this.eventDetails = eventDetails;
  }

  public Date getEventTime() {
    return eventTime;
  }

  public String getEventType() {
    return eventType;
  }

  public String getVehicleID() {
    return vehicleID;
  }

  public String getEventSource() {
    return eventSource;
  }

  public Map getEventDetails() {
    Map<String, String> details = new HashMap<>();
    details.put("message", eventDetails);
    return details;
  }
}
