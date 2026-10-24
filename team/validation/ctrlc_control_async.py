import asyncio
async def main():
    while True:
        await asyncio.sleep(0.1)
try:
    asyncio.run(main())
except KeyboardInterrupt:
    print("async control got KeyboardInterrupt")
