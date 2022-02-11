### This is a Solution to use a cloud function as a notification webhook  for alert policies. The cloud function is used to push a card message to a Google chatbot webhook.

Here are the guidelines for implementing the solution in your GCP environment:

1. Navigate to theGCP and create a new Cloud Function (for simplicity cf is setup as an unauthentication function):
    - a) Set the CF function keeping the https option turned on
    - b) keep the default of the runtime
    - c) Add 2runtime env  variables BOT_URL which is the bot webhook url and AUTH_TOKEN which is a manual genreated token to authenticate the alert policy on the function (alternatively Basic auth can be used for SA)
    - d) Select the inline editor and latest python runtime version and use the attached requirements.txt and main.py code
    - e) Make sure that notify_chat_bot is selected as the entry point before deploying the cloud function

2. Navigate to alerting under Monitoring to add the cf as a webhook notification channel:
    - a) Click on edit notifications channels and navigate to webhooks and add the cf as a webhook (endpoint url is cf url, same url displayed in the trigger tab, appending to it the auth_token configured in the runtime env variables tab for the cf) example: https://us-central1-ddfffff.cloudfunctions.net/cf-name?auth_token=ffcdhhghghggegge.
        Test the connection and you should get a card message in your chat bot.
    - b) Now you should be able to create a new alert policy with the newly defined notofocation chanel and get the notification upon any condition happening.