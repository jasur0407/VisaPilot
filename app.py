from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi import Request
from pydantic import BaseModel
import httpx
import json

app = FastAPI(title = "VisaApp")
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)

templates = Jinja2Templates(directory="templates")


class ChatRequest(BaseModel):
    message: str


conversation = []


@app.get("/", response_class=HTMLResponse)

async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html"
    )


@app.post("/api/chat")
async def chat(request: ChatRequest):

    conversation.append({
        "role": "user",
        "content": request.message
    })

    async def generate():

        full_response = ""

        async with httpx.AsyncClient(timeout=60) as client:

            async with client.stream(
                "POST",
                "http://localhost:11434/api/chat",
                json={
                    "model": "llama3.2",
                    "messages": conversation,
                    "stream": True
                }
            ) as response:
                
                async for line in response.aiter_lines():
                    if not line:
                        continue

                    try:
                        data = json.loads(line)

                        if "message" in data and "content" in data["message"]:
                            token = data["message"]["content"]
                            full_response += token
                            yield token
                    except json.JSONDecodeError:
                        continue

        conversation.append({
            "role": "assistant",
            "content": full_response
        })

    return StreamingResponse(
        generate(),
        media_type="text/plain"
    )