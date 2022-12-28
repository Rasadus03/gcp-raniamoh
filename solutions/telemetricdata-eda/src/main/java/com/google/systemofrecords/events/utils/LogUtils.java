package com.google.systemofrecords.events.utils;

import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class LogUtils {

  static Map<Class, Logger> LOGGER = new HashMap();

  private static Logger getLogger(Class clazz) {
    if (!LOGGER.containsKey(clazz)) {
      LOGGER.put(clazz, Logger.getLogger(clazz.getName()));
    }
    return LOGGER.get(clazz);
  }

  public static void info(Class clazz, String message) {
    getLogger(clazz).log(Level.INFO, message);
  }

  public static void debug(Class clazz, String message) {
    getLogger(clazz).log(Level.FINE, message);
  }

  public static void error(Class clazz, String message) {
    getLogger(clazz).log(Level.SEVERE, message);
  }

  public static void fatal(Class clazz, String message) {
    getLogger(clazz).log(Level.SEVERE, message);
  }

  public static void warn(Class clazz, String message) {
    getLogger(clazz).log(Level.WARNING, message);
  }

}
