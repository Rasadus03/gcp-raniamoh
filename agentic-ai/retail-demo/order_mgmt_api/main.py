import os
from flask import Flask, request, jsonify
import sqlalchemy
from google.cloud.sql.connector import Connector

app = Flask(__name__)

# Initialize Cloud SQL Connector
connector = Connector()

def get_db_connection() -> sqlalchemy.engine.Engine:
    """Creates a SQLAlchemy engine for Cloud SQL using the Connector."""
    try:
        instance_connection_name = os.environ["INSTANCE_CONNECTION_NAME"]
        db_user = os.environ["DB_USER"]
        db_name = os.environ["DB_NAME"]
        db_pass = os.environ["DB_PASSWORD"]
        def getconn():
            conn = connector.connect(
                instance_connection_name,
                "pg8000",
                user=db_user,
                password=db_pass,
                db=db_name,
                enable_iam_auth=False
            )
            return conn

        engine = sqlalchemy.create_engine(
            "postgresql+pg8000://",
            creator=getconn,
            pool_recycle=3600  # Recycle connections to prevent stale connections
        )
        return engine
    except Exception as e:
        print(f"Error creating DB connection: {e}")
        raise

engine = None
try:
    engine = get_db_connection()
    print("Successfully connected to Cloud SQL")
except Exception as e:
    print(f"Failed to connect to Cloud SQL on startup: {e}")


@app.route('/place_order', methods=['POST'])
def place_order():
    if not engine:
        return jsonify({"error": "Database connection not available"}), 500

    data = request.get_json()
    print(f"Received data: {data}")

    if not data:
        return jsonify({"error": "Invalid JSON payload"}), 400

    customer_id = data['customer_id']
    print(f"Received customer_id: {customer_id}")
    items = data['items']  # Expected format: [{"product_id": "SKU123", "quantity": 1}, ...]
    print(f"Received items: {items}")

    if not customer_id or not items or not isinstance(items, list):
        return jsonify({"error": "Missing customer_id or items"}), 400

    conn = None
    try:
        conn = engine.connect()
        total_order_price=0
        with conn.begin() as transaction:  # Start a transaction
            # 1. Create an entry in the orders table
            insert_order_stmt = sqlalchemy.text(
                "INSERT INTO orders (user_id) VALUES (:customer_id) RETURNING order_id;"
            )
            result = conn.execute(insert_order_stmt, {"customer_id": customer_id})
            order_id = result.scalar_one()
            print(f"After insert {order_id}")
            # 2. Process each item in the order
            for item in items:
                product_id = item.get('product_id')
                quantity = item.get('quantity')
                print(f"product_id {product_id}")
                print(f"quantity {quantity}")
                if not product_id or not isinstance(quantity, int) or quantity <= 0:
                    transaction.rollback()
                    return jsonify({"error": f"Invalid item format: {item}"}), 400

                # 2a. Check inventory
                check_inv_stmt = sqlalchemy.text(
                    "SELECT SUM(stock_level) as total_stock FROM inventory WHERE product_id = :product_id;"
                )
                inv_result = conn.execute(check_inv_stmt, {"product_id": product_id}).fetchone()
                print(f"inv_result {inv_result}")
                total_stock = inv_result[0] if inv_result else 0
                print(f"total_stock {total_stock}")

                if total_stock is None or total_stock < quantity:
                    transaction.rollback()
                    return jsonify({"error": f"Not enough stock for {product_id}. Available: {total_stock}, Requested: {quantity}"}), 400

                # 2b. Get product price
                prod_price_stmt = sqlalchemy.text( "SELECT PRICE FROM PRODUCTS WHERE PRODUCT_ID=:product_id;")
                prod_price_result = conn.execute(prod_price_stmt, {"product_id": product_id}).fetchone()
                price = prod_price_result[0]
                if price <= 0:
                    transaction.rollback()
                    return jsonify({"error": f"Could not determine price for {product_id}"}), 400
                print(f"price {price}")
                total_order_price = total_order_price + price
                # 2c. Insert into order_items
                insert_item_stmt = sqlalchemy.text(
                    """
                    INSERT INTO order_items (order_id, product_id, quantity, price)
                    VALUES (:order_id, :product_id, :quantity, :price);
                    """
                )
                conn.execute(insert_item_stmt, {
                    "order_id": order_id,
                    "product_id": product_id,
                    "quantity": quantity,
                    "price": price
                })

                # 2d. Decrement inventory
                # This part is tricky. Need to decrement from specific locations if modeled.
                # Simplistic decrement from the first found location:
                update_inv_stmt = sqlalchemy.text(
                    """
                    UPDATE inventory
                    SET stock_level = stock_level - :quantity
                    WHERE product_id = :product_id AND inventory_id = (
                        SELECT inventory_id FROM inventory
                        WHERE product_id = :product_id AND stock_level >= :quantity
                        LIMIT 1
                    )
                    RETURNING inventory_id;
                    """
                )
                update_result = conn.execute(update_inv_stmt, {"quantity": quantity, "product_id": product_id})
                if update_result.rowcount == 0:
                    # This should ideally not happen if the SUM check passed, but good to have.
                    transaction.rollback()
                    return jsonify({"error": f"Failed to update inventory for {product_id}"}), 500
                
                update_order_stmt = sqlalchemy.text(
                    """
                    UPDATE orders
                    SET total_amount = :total_order_price
                    WHERE order_id = :order_id 
                    RETURNING order_id;
                    """
                )
                update_result = conn.execute(update_order_stmt, {"total_order_price": total_order_price, "order_id": order_id})
                if update_result.rowcount == 0:
                    # This should ideally not happen if the SUM check passed, but good to have.
                    transaction.rollback()
                    return jsonify({"error": f"Failed to update order for {order_id}"}), 500

            # If all items processed, commit the transaction
            transaction.commit()
            return jsonify({"message": "Order placed successfully", "order_id": order_id}), 201

    except sqlalchemy.exc.SQLAlchemyError as e:
        print(f"Database error during order placement: {e}")
        # Transaction is automatically rolled back by the context manager exit
        return jsonify({"error": "Failed to place order due to database error"}), 500
    except Exception as e:
        print(f"Unexpected error during order placement: {e}")
        return jsonify({"error": "An unexpected error occurred"}), 500
    finally:
        if conn:
            conn.close()
        connector.close() # Close connector to free up resources

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
