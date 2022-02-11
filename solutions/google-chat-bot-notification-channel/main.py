import json
import os

from flask import make_response
from httplib2 import Http

def create_card(incident):
  msg = {
    "cards": [
      {
        "header": {
          "title": "<b>Stackdriver Incident: " + incident.get('policy_name', '') + "</b>",
          "subtitle": incident.get('state')
        },
        "sections": [
          {
            "widgets": [
              {
                "textParagraph": {
                  "text": incident.get('summary')
                }
              },
              {
                "buttons": [
                  {
                    "textButton": {
                      "text": "OPEN IN STACKDRIVER",
                      "onClick": {
                        "openLink": {
                          "url": incident.get('url')
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
  
  return json.dumps(msg)


def notify_chat_bot(request):
    AUTH_TOKEN = os.environ['AUTH_TOKEN']
    BOT_URL = os.environ['BOT_URL']
    request_json = request.get_json()
    user_auth_token = None
    if request.args and 'auth_token' in request.args:
        user_auth_token = request.args.get('auth_token')
    elif 'auth_token' in request_json:
        user_auth_token = request_json.get('auth_token')
    if not user_auth_token or user_auth_token != AUTH_TOKEN:
        return make_response('Authentication Failed', 401, {})
    incident = request_json['incident']
    message_headers = { 'Content-Type': 'application/json; charset=UTF-8'}
    http_obj = Http()
    response = http_obj.request(
        uri=BOT_URL,
        method='POST',
        headers=message_headers,
        body=create_card(incident),
    )
    # for the logs
    print(response)
