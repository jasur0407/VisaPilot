from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi import Request
from pydantic import BaseModel
import httpx

app = FastAPI(title = "VisaApp")
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)

templates = Jinja2Templates(directory="templates")


class ChatRequest(BaseModel):
    message: str

@app.get("/", response_class=HTMLResponse)

async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html"
    )


@app.post("/api/chat")
async def chat(request: ChatRequest):
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "http://localhost:11434/api/generate",
            json={
                "model": "llama3.2",
                "prompt": request.message,
                "stream": False
            }
        )

    data = response.json()

    return {
        "answer": data['response']
    }