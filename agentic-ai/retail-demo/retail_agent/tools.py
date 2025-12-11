import os
import requests

def main():
    print(f"This is the Order Placement MSA Tool!")
    
def call_place_order_api(customer_order: str) -> dict:
    """Calls the Cloud Function API to place an order."""
    print(f"Tool: Placing order with details {customer_order}")
    function_url = os.environ.get("PLACE_ORDER_FUNCTION_URL")
    if not function_url:
        return {"error": "Place Order API URL not configured."}

    try:

        headers = {
            "Content-Type": "application/json"
        }
        payload = customer_order
        
        response = requests.post(url=function_url, data=payload, headers=headers)
        response.raise_for_status()  # Raise an exception for bad status codes
        return response.json()
    except Exception as e:
        print(f"Error calling Place Order API: {e}")
        return {"error": f"Failed to place order: {str(e)}"}

if __name__ == "__main__":
    main()