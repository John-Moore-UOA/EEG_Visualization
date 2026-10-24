import time
try:
    while True:
        time.sleep(0.1)
except KeyboardInterrupt:
    print("control got KeyboardInterrupt")
