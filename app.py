from fastapi import FastAPI, Request, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
import httpx
import json
import os
import shutil

from langchain_community.document_loaders import PyMuPDFLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import OllamaEmbeddings
from langchain_community.tools import DuckDuckGoSearchRun 

app = FastAPI(title = "VisaApp")
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)
templates = Jinja2Templates(directory="templates")


embeddings = OllamaEmbeddings(model = "nomic-embed-text")
vectorstore = Chroma(embedding_function = embeddings, persist_directory="./chroma_db")


search_tool = DuckDuckGoSearchRun()

class ChatRequest(BaseModel):
    message: str
    use_web_search: bool = True


@app.get("/", response_class=HTMLResponse)

async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html"
    )


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    file_path = f"temp_{file.filename}"
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        if file.filename.endswith(".pdf"):
            loader = PyMuPDFLoader(file_path)
        elif file.filename.endswith(".docx"):
            loader = Docx2txtLoader(file_path)
        else:
            os.remove(file_path)
            return {"error": "Unsupported format!!"}
        
        documents = loader.load()

        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        chunks = text_splitter.split_documents(documents)
        print(f"Successfully split document into {len(chunks)} chunks")

        vectorstore.add_documents(chunks)
    
    except Exception as e:
        return {"error": f"Failed to process: {str(e)}"}
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)
        
    return {"message": f"Successfully learned from {file.filename}"}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    user_msg = request.message

    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})
    relevant_docs = retriever.invoke(user_msg)
    print(f"Found {len(relevant_docs)} matching chunks in the database for query: '{user_msg}'")

    doc_context = "\n\n".join([doc.page_content for doc in relevant_docs])

    web_context = ""
    if request.use_web_search:
        routing_prompt = f"""You are a query router. Analyze the following user message and decide if answering it requires real-time, current information from the internet.
        Respond with exactly one word: 'SEARCH' or 'LOCAL'.
        User message: "{user_msg}"
        Response:"""

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                route_resp = await client.post(
                    "http://localhost:11434/api/generate",
                    json={
                        "model": "llama3.2",
                        "prompt": routing_prompt,
                        "stream": False
                    }
                )
                decision = route_resp.json().get("response", "").strip().upper()

                if "SEARCH" in decision:
                    print(f"Executing Web Search for query '{user_msg}'...")
                    web_context = search_tool.run(user_msg)
                    print("Search completed")
                else:
                    print("Processing query locally using document context")
            
        except Exception as e:
            print(f"Warning: Routing/Search tool failed: {e}. Falling back to default data.")
    else:
        print("Web search explicitly disabled by user. Skipping internet search.")

    system_prompt = f"""You are VisaPilot, a RAG-powered web assistant that helps applicants manage a study-abroad or student-visa application from start to finish. 

    YOUR CORE CAPABILITIES & IDENTITY:
    - The user uploads their own documents—including passports, transcripts, financial proof, and embassy correspondence.
    - Your job is to check them against current requirements, explain what is missing, answer questions about their specific case, and draft supporting letters.
    - You run fully locally so sensitive documents never leave the user’s machine. Keep this in mind and reassure the user if they ask about data privacy.
    - You remember each applicant’s case across sessions.

    INSTRUCTIONS:
    Prioritize information found in the USER UPLOADED DOCUMENTS for personal information. Use the LIVE WEB SEARCH RESULTS to answer questions about external constraints, live schedules, current fees, or dynamic embassy rules. 

    USER UPLOADED DOCUMENTS (Context):
    {doc_context if doc_context else "No local documents uploaded yet relating to this question."}

    LIVE WEB SEARCH RESULTS (Real-time Context):
    {web_context if web_context else "No web search executed for this query."}
    """

    async def generate():

        full_response = ""

        async with httpx.AsyncClient(timeout=120) as client:

            async with client.stream(
                "POST",
                "http://localhost:11434/api/chat",
                json={
                    "model": "llama3.2",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg}
                    ],
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

    return StreamingResponse(
        generate(),
        media_type="text/plain"
    )