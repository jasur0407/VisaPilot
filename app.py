from fastapi import FastAPI, Request, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field
import httpx
import json
import os
import shutil
import base64
from typing import List, Optional

from langchain_community.document_loaders import PyMuPDFLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import OllamaEmbeddings
from langchain_community.tools import DuckDuckGoSearchRun 
from langchain_core.documents import Document

from mem0 import Memory

app = FastAPI(title="VisaApp")

# Safeguard directory initialization
os.makedirs("static", exist_ok=True)
os.makedirs("templates", exist_ok=True)

app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)
templates = Jinja2Templates(directory="templates")

# Initialize embeddings and Chroma safely
try:
    embeddings = OllamaEmbeddings(model="nomic-embed-text")
    vectorstore = Chroma(embedding_function=embeddings, persist_directory="./chroma_db")
except Exception as e:
    print(f"Warning: Failed to initialize LangChain Chroma/Embeddings: {e}")
    embeddings = None
    vectorstore = None

# Initialize DuckDuckGo search tool safely
try:
    search_tool = DuckDuckGoSearchRun()
except Exception as e:
    print(f"Warning: DuckDuckGo initialization failed: {e}")
    search_tool = None

# Clean Mem0 configuration
mem0_config = {
    "vector_store": {
        "provider": "chroma",
        "config": {
            "collection_name": "visapilot_memories",
            "path": "./mem0_db"
        }
    },
    "llm": {
        "provider": "ollama",
        "config": {
            "model": "llama3.2",
            "ollama_base_url": "http://localhost:11434"
        }
    },
    "embedder": {
        "provider": "ollama",
        "config": {
            "model": "nomic-embed-text",
            "ollama_base_url": "http://localhost:11434"
        }
    }
}

memory = None
try:
    memory = Memory.from_config(mem0_config)
except Exception as e:
    print(f"Warning: Failed to initialize Mem0 memory store: {e}")
    memory = None

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    use_web_search: bool = True
    chat_history: List[Message] = Field(default_factory=list)

async def analyze_id_or_passport_image(image_bytes: bytes, filename: str) -> str:
    """Uses Ollama Vision capabilities (Qwen2.5-VL / Llava / Moondream) to extract key details from ID and Passport images."""
    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    
    # Direct OCR prompt
    prompt = (
        "Read and transcribe all visible text in this document photo verbatim. "
        "List all details you can find including: Full Name, Document Number / Card Number, "
        "Date of Birth, Expiry Date, Issue Date, Country, and any other printed numbers or text."
    )
    
    target_models = [
        "qwen2.5vl:3b",
        "qwen2.5vl:latest",
        "qwen2.5vl",
        "llava:latest",
        "llava",
        "moondream:latest",
        "moondream"
    ]
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        for model in target_models:
            try:
                print(f"[Vision System] Sending image to '{model}'...")
                response = await client.post(
                    "http://localhost:11434/api/chat",
                    json={
                        "model": model,
                        "messages": [
                            {
                                "role": "user",
                                "content": prompt,
                                "images": [base64_image]
                            }
                        ],
                        "stream": False
                    }
                )
                
                if response.status_code == 200:
                    data = response.json()
                    extracted_content = data.get("message", {}).get("content", "").strip()
                    if extracted_content and not extracted_content.startswith("ids ="):
                        print(f"[Vision System] Success with '{model}'!")
                        return extracted_content
                else:
                    print(f"[Vision System] Model '{model}' returned status {response.status_code}")

            except Exception as err:
                print(f"[Vision System] Error querying '{model}': {err}")
                continue
                
    return "⚠️ Unable to analyze image. Please ensure a vision model is running."


@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    index_path = os.path.join("templates", "index.html")
    if not os.path.exists(index_path) and os.path.exists("index.html"):
        with open("index.html", "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return templates.TemplateResponse(request, "index.html")


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    if vectorstore is None:
        return {"error": "Vector database not initialized. Please ensure Ollama is running."}

    os.makedirs("temp", exist_ok=True)
    temp_file_path = os.path.join("temp", file.filename)
    filename_lower = file.filename.lower()
    image_extensions = (".png", ".jpg", ".jpeg", ".webp")

    try:
        # Save file locally
        with open(temp_file_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)

        # IMAGE ANALYSIS PATH (Passport / ID / Visa Images)
        if filename_lower.endswith(image_extensions):
            with open(temp_file_path, "rb") as img_f:
                image_bytes = img_f.read()
            
            extracted_text = await analyze_id_or_passport_image(image_bytes, file.filename)
            
            # Save extracted identity document text into vector store so RAG can query it
            doc = Document(
                page_content=f"--- Extracted Identity/Passport Data ({file.filename}) ---\n{extracted_text}",
                metadata={"source": file.filename, "type": "id_passport_analysis"}
            )
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
            splits = text_splitter.split_documents([doc])
            vectorstore.add_documents(splits)

            return {
                "message": f"Successfully processed and analyzed image: '{file.filename}'!",
                "analysis": extracted_text
            }

        # DOCUMENT PATH (.pdf / .docx)
        elif filename_lower.endswith(".pdf"):
            loader = PyMuPDFLoader(temp_file_path)
        elif filename_lower.endswith(".docx"):
            loader = Docx2txtLoader(temp_file_path)
        else:
            return {"error": "Unsupported file format. Please upload PDF, DOCX, PNG, JPG, or WEBP."}

        docs = loader.load()
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        splits = text_splitter.split_documents(docs)
        
        for split in splits:
            split.metadata["source"] = file.filename

        vectorstore.add_documents(splits)
        return {"message": f"Successfully loaded and indexed {file.filename}!"}
    
    except Exception as e:
        return {"error": f"Failed to process file: {str(e)}"}
    
    finally:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)


@app.post("/api/clear-documents")
async def clear_documents():
    global vectorstore
    try:
        if vectorstore is not None:
            try:
                vectorstore.delete_collection()
            except Exception as coll_err:
                print(f"Primary collection deletion bypassed/failed: {coll_err}")
            
            if embeddings:
                vectorstore = Chroma(embedding_function=embeddings, persist_directory="./chroma_db")
                
            return {"message": "All uploaded documents successfully cleared!"}
        else:
            if os.path.exists("./chroma_db"):
                shutil.rmtree("./chroma_db")
            if embeddings:
                vectorstore = Chroma(embedding_function=embeddings, persist_directory="./chroma_db")
            return {"message": "All uploaded documents successfully cleared!"}
            
    except Exception as e:
        return {"error": f"Failed to clear documents: {str(e)}"}


@app.post("/api/clear-memory")
async def clear_chat_memory(payload: dict):
    """Clears conversation memory/Mem0 context for a session while preserving uploaded document files."""
    user_id = payload.get("user_id", "default_user")
    
    try:
        if 'memory' in globals() and memory is not None:
            try:
                memory.delete_all(user_id=user_id)
                print(f"[Memory System] Cleared Mem0 context for user/session: {user_id}")
            except Exception as mem_err:
                print(f"[Memory System] Mem0 delete error: {mem_err}")

        return {
            "status": "success", 
            "message": "Chat memory successfully cleared. Uploaded documents preserved."
        }
    except Exception as e:
        print(f"[Memory System] Failed to clear memory: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    user_msg = request.message
    user_id = "applicant_01"  
    memory_context = ""
    retrieved_docs_text = ""

    # 1. Fetch long-term memory
    if memory:
        try:
            past_memories = memory.search(query=user_msg, filters={"user_id": user_id})
            results_list = past_memories.get("results", []) if isinstance(past_memories, dict) else past_memories
            if results_list:
                memory_context = "\n".join([f"- {m.get('memory', m)}" for m in results_list if isinstance(m, dict)])
        except Exception as e:
            print(f"Failed to query memory bank: {e}")

    # 2. Enhanced RAG Retrieval with Upload Keyword Fallback
    if vectorstore:
        try:
            # Direct semantic search
            retriever = vectorstore.as_retriever(search_kwargs={"k": 5})
            relevant_docs = retriever.invoke(user_msg)

            # Fallback: If user asks about uploaded files explicitly, pull vectorstore items directly
            file_keywords = ["image", "uploaded", "file", "document", "passport", "id", "photo", "inside", "letter", "sponsorship", "pdf", "proof"]
            if any(kw in user_msg.lower() for kw in file_keywords):
                all_docs = vectorstore.get()
                if all_docs and "documents" in all_docs and all_docs["documents"]:
                    extra_docs = [
                        f"--- Document ({meta.get('source', 'Uploaded File')}) ---\n{doc}"
                        for doc, meta in zip(all_docs["documents"], all_docs["metadatas"])
                    ]
                    retrieved_docs_text = "\n\n".join(extra_docs)

            if not retrieved_docs_text and relevant_docs:
                retrieved_docs_text = "\n\n".join([
                    f"--- Source: {doc.metadata.get('source', 'Unknown')} ---\n{doc.page_content}"
                    for doc in relevant_docs
                ])
        except Exception as e:
            print(f"Failed to query document vectorstore: {e}")

    # 3. Intelligent Search Router (Suppressed when evaluating uploaded documents)
    web_search_context = ""
    decision = "NO"
    web_search_triggered = False 

    # Check if the query specifically target an uploaded file
    doc_eval_keywords = ["uploaded", "this document", "my letter", "my pdf", "sponsorship letter", "my passport", "my file", "check my", "review my", "sponsorship", "proof requirement"]
    is_doc_evaluation = any(kw in user_msg.lower() for kw in doc_eval_keywords) and bool(retrieved_docs_text)
    
    if request.use_web_search and search_tool and not is_doc_evaluation:
        try:
            routing_prompt = (
                f"Determine if the user query requires real-time information, current event details, "
                f"live data, current dates, or web search to answer accurately.\n"
                f"Query: '{user_msg}'\n"
                f"Reply with ONLY 'YES' or 'NO' and nothing else."
            )
            
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    "http://localhost:11434/api/chat",
                    json={
                        "model": "llama3.2",
                        "messages": [{"role": "user", "content": routing_prompt}],
                        "stream": False
                    }
                )
                if response.status_code == 200:
                    data = response.json()
                    decision = data.get("message", {}).get("content", "").strip().upper()
        except Exception as e:
            print(f"Failed to run search router: {e}")

        if "YES" in decision:
            web_search_triggered = True
            try:
                web_search_context = await search_tool.arun(user_msg)
            except Exception as e:
                print(f"Web search execution error: {e}")

    # 4. Construct System Prompt
    system_prompt = (
        "You are VisaPilot, an authoritative AI Visa Assistant designed to help applicants "
        "navigate visa application frameworks, documentation checklists, and application procedures.\n\n"
        "### CHECKLIST GENERATION RULES:\n"
        "Whenever the user asks for a checklist, to-do list, or required documents, you MUST wrap the items exactly inside `<checklist>` and `</checklist>` tags.\n"
        "Structure the items using standard markdown task lists inside the tags.\n"
        "Example:\n"
        "<checklist>\n"
        "- [ ] Valid Passport\n"
        "- [ ] Travel Insurance\n"
        "</checklist>\n"
        "Do not place checkboxes outside of these tags. Keep tasks short and actionable.\n\n"
        "### DOCUMENT EVALUATION RULES:\n"
        "When evaluating uploaded document text/analysis provided below:\n"
        "1. Do NOT output generic advice or general checklists on what a document 'should' contain unless explicitly asked.\n"
        "2. Evaluate the ACTUAL content provided line-by-line against standard visa/sponsorship requirements.\n"
        "3. Explicitly state whether the uploaded document passes or fails these checks based on its actual text.\n"
        "4. Highlight specific details found in the text (e.g., exact sponsor name, specific coverage amount like €12,000) and explicitly point out any missing critical elements (e.g., missing date, missing signature, missing passport number).\n\n"
    )

    if memory_context:
        system_prompt += f"### ESTABLISHED APPLICANT CONTEXT:\n{memory_context}\n\n"

    if retrieved_docs_text:
        system_prompt += (
            "### UPLOADED VISA DOCUMENTS & PASSPORT/ID ANALYSIS:\n"
            "The user has uploaded documents/images. Here is the extracted content:\n"
            f"{retrieved_docs_text}\n\n"
        )

    if web_search_context:
        system_prompt += f"### LIVE WEB SEARCH RESULTS:\n{web_search_context}\n\n"

    system_prompt += (
        "Maintain a highly organized, professional, and comforting tone. "
        "Structure advice with headers, clean bullet points, and numbered steps."
    )

    messages_payload = [{"role": "system", "content": system_prompt}]
    for msg in request.chat_history:
        messages_payload.append({"role": msg.role, "content": msg.content})
    messages_payload.append({"role": "user", "content": user_msg})

    async def generate():
        if web_search_triggered:
            yield "🔍 *Searching the web...*\n\n"
            
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST",
                    "http://localhost:11434/api/chat",
                    json={
                        "model": "llama3.2",
                        "messages": messages_payload,
                        "stream": True
                    }
                ) as response:
                    if response.status_code != 200:
                        yield f"Ollama returned status code {response.status_code}. Make sure Ollama is running!"
                        return

                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            if "message" in data and "content" in data["message"]:
                                token = data["message"]["content"]
                                yield token
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            yield f"\n\n[Ollama Connection Error: Verify that Ollama is running on port 11434. Error: {str(e)}]"

    return StreamingResponse(generate(), media_type="text/plain")