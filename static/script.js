const input = document.getElementById("message-input");
const button = document.getElementById("send-btn");
const chatBox = document.getElementById("chat-box");
const webSearchToggle = document.getElementById("web-search-toggle");

const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const clearDocsBtn = document.getElementById("clear-docs-btn");
const uploadStatus = document.getElementById("upload-status");

const newChatBtn = document.getElementById("new-chat-btn");
const chatListContainer = document.getElementById("chat-list");

// Fix: Use the modern marked parsing configuration interface
marked.use({ gfm: true, breaks: true });

// Safe Multi-chat parsing with try/catch to protect against local storage corruption
let chats = [];
try {
    chats = JSON.parse(localStorage.getItem("visapilot_chats")) || [];
} catch (e) {
    console.error("Local storage state parsed with error. Cleaning context...", e);
    localStorage.removeItem("visapilot_chats");
    chats = [];
}

let activeChatId = localStorage.getItem("visapilot_active_chat_id") || null;

if (chats.length === 0) {
    createNewChat("Initial Consultation");
} else if (!activeChatId || !chats.find(c => c.id === activeChatId)) {
    activeChatId = chats[0].id;
    saveState();
}

// Reset uploaded elements on fresh reload
fetch("/api/clear-documents", { method: "POST" }).catch(() => {});

renderChatList();
renderActiveChatMessages();

input.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = (this.scrollHeight) + "px";
});

input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        button.click();
    }
});

function createNewChat(title = "New Consultation") {
    const newChat = {
        id: "chat_" + Date.now(),
        title: title,
        messages: []
    };
    chats.unshift(newChat);
    activeChatId = newChat.id;
    saveState();
    renderChatList();
    renderActiveChatMessages();
}

function deleteChat(chatId, event) {
    event.stopPropagation();
    chats = chats.filter(c => c.id !== chatId);
    
    if (chats.length === 0) {
        createNewChat("Initial Consultation");
    } else if (activeChatId === chatId) {
        activeChatId = chats[0].id;
    }
    
    saveState();
    renderChatList();
    renderActiveChatMessages();
}

function selectChat(chatId) {
    activeChatId = chatId;
    saveState();
    renderChatList();
    renderActiveChatMessages();
}

function saveState() {
    localStorage.setItem("visapilot_chats", JSON.stringify(chats));
    localStorage.setItem("visapilot_active_chat_id", activeChatId);
}

function renderChatList() {
    chatListContainer.innerHTML = "";
    chats.forEach(chat => {
        const item = document.createElement("div");
        item.classList.add("chat-item");
        if (chat.id === activeChatId) {
            item.classList.add("active");
        }
        item.addEventListener("click", () => selectChat(chat.id));

        const titleSpan = document.createElement("span");
        titleSpan.classList.add("chat-title-text");
        titleSpan.textContent = chat.title;

        const delBtn = document.createElement("button");
        delBtn.classList.add("delete-chat-btn");
        delBtn.innerHTML = "&times;";
        delBtn.title = "Delete thread";
        delBtn.addEventListener("click", (e) => deleteChat(chat.id, e));

        item.appendChild(titleSpan);
        item.appendChild(delBtn);
        chatListContainer.appendChild(item);
    });
}

function renderActiveChatMessages() {
    chatBox.innerHTML = "";
    const activeChat = chats.find(c => c.id === activeChatId);
    if (!activeChat) return;

    activeChat.messages.forEach(msg => {
        const senderLabel = msg.role === "user" ? "You" : "VisaPilot";
        addMessageToBox(senderLabel, msg.content, msg.role === "user");
    });
    chatBox.scrollTop = chatBox.scrollHeight;
}

function addMessageToBox(sender, text = "", isUser = false) {
    const div = document.createElement("div");
    div.classList.add("message-row", isUser ? "you" : "visapilot");
    
    if (isUser) {
        div.innerHTML = `<strong>${sender}:</strong> <span>${escapeHtml(text)}</span>`;
        chatBox.appendChild(div);
        return div.querySelector("span");
    } else {
        div.innerHTML = `<strong>${sender}:</strong> <div class="markdown-body" style="display:inline-block; margin-left:5px;"></div>`;
        chatBox.appendChild(div);
        const mdBody = div.querySelector(".markdown-body");
        mdBody.innerHTML = marked.parse(text);
        return mdBody;
    }
}

function escapeHtml(unsafe) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

newChatBtn.addEventListener("click", () => {
    createNewChat();
});

// Helper to prevent input submission during response streams
function toggleChatControls(disabled) {
    input.disabled = disabled;
    button.disabled = disabled;
}

button.addEventListener("click", async () => {
    const messageText = input.value.trim();
    if (!messageText) return;

    const activeChat = chats.find(c => c.id === activeChatId);
    if (!activeChat) return;

    // Turn off submission while generating response
    toggleChatControls(true);

    addMessageToBox("You", messageText, true);
    input.value = "";
    input.style.height = "auto";

    // Extract short-term context prior to appending the new message
    const payloadHistory = activeChat.messages.map(m => ({
        role: m.role,
        content: m.content
    }));

    activeChat.messages.push({ role: "user", content: messageText });
    
    if (activeChat.title === "New Consultation" || activeChat.title === "Initial Consultation") {
        activeChat.title = messageText.length > 25 ? messageText.substring(0, 22) + "..." : messageText;
        renderChatList();
    }
    saveState();

    const streamSpan = addMessageToBox("VisaPilot", "", false);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: messageText,
                use_web_search: webSearchToggle.checked,
                chat_history: payloadHistory
            })
        });

        if (!response.ok) {
            const errorMsg = `Server Connection Failure (${response.statusText})`;
            streamSpan.innerHTML = marked.parse(errorMsg);
            // Fix: Do not save transient error messages to chat state to avoid history context pollution
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantResponse = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            assistantResponse += chunk;
            streamSpan.innerHTML = marked.parse(assistantResponse);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        activeChat.messages.push({ role: "assistant", content: assistantResponse });
        saveState();

    } catch (error) {
        console.error("Connection error:", error);
        const errAlert = "\n\n[Failed to stream response. Please ensure your FastAPI backend is active]";
        streamSpan.innerHTML = marked.parse(errAlert);
        // Fix: Do not save error boundaries to active chat context 
    } finally {
        toggleChatControls(false);
        input.focus();
    }
});

uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];

    if (!file) {
        uploadStatus.textContent = "Please select a file first";
        uploadStatus.style.color = 'red';
        return;
    }

    uploadStatus.textContent = `Uploading and parsing ${file.name}...`;
    uploadStatus.style.color = 'blue';
    uploadBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch("/api/upload", {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (response.ok && !data.error) {
            uploadStatus.textContent = data.message;
            uploadStatus.style.color = 'green';
            fileInput.value = '';
        } else {
            uploadStatus.textContent = data.error || "Upload failed";
            uploadStatus.style.color = 'red';
        }
    } catch (error) {
        console.error("Upload Error:", error);
        uploadStatus.textContent = "Error establishing context with file processing API.";
        uploadStatus.style.color = 'red';
    } finally {
        uploadBtn.disabled = false;
    }
});

// Click handler to delete all uploaded and indexed files
clearDocsBtn.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete all uploaded visa documents from VisaPilot's memory?")) {
        return;
    }

    uploadStatus.textContent = "Clearing document memory bank...";
    uploadStatus.style.color = 'blue';
    clearDocsBtn.disabled = true;

    try {
        const response = await fetch("/api/clear-documents", {
            method: "POST"
        });

        const data = await response.json();

        if (response.ok && !data.error) {
            uploadStatus.textContent = "Successfully cleared all uploaded files from memory!";
            uploadStatus.style.color = 'green';
            fileInput.value = ''; // Reset file input
        } else {
            uploadStatus.textContent = data.error || "Failed to clear documents.";
            uploadStatus.style.color = 'red';
        }
    } catch (error) {
        console.error("Clear Documents Error:", error);
        uploadStatus.textContent = "Error connecting to backend to clear document memory.";
        uploadStatus.style.color = 'red';
    } finally {
        clearDocsBtn.disabled = false;
    }
});