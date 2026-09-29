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

const clearMemoryBtn = document.getElementById("clear-memory-btn");

// Modern marked parsing configuration interface
marked.use({ gfm: true, breaks: true });

// Safe Multi-chat parsing
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

    activeChat.messages.forEach((msg, msgIndex) => {
        const senderLabel = msg.role === "user" ? "You" : "VisaPilot";
        addMessageToBox(senderLabel, msg.content, msg.role === "user", msgIndex);
    });
    chatBox.scrollTop = chatBox.scrollHeight;
}

function addMessageToBox(sender, text = "", isUser = false, msgIndex = null) {
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
        
        // Make checkboxes interactive if message index is present
        if (msgIndex !== null) {
            makeCheckboxesInteractive(mdBody, msgIndex);
        }
        return mdBody;
    }
}

function makeCheckboxesInteractive(container, msgIndex) {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length === 0) return;

    checkboxes.forEach((cb, cbIndex) => {
        cb.removeAttribute('disabled'); // Enable click interactions
        cb.classList.add('interactive-task-checkbox');

        cb.addEventListener('change', () => {
            const activeChat = chats.find(c => c.id === activeChatId);
            if (!activeChat || !activeChat.messages[msgIndex]) return;

            let content = activeChat.messages[msgIndex].content;
            let currentTaskCount = 0;

            // Regex match both unchecked [- ] and checked [x] task items
            const taskRegex = /- \[( |x|X)\]/g;
            
            content = content.replace(taskRegex, (match) => {
                if (currentTaskCount === cbIndex) {
                    currentTaskCount++;
                    return cb.checked ? "- [x]" : "- [ ]";
                }
                currentTaskCount++;
                return match;
            });

            // Persist updated checklist state
            activeChat.messages[msgIndex].content = content;
            saveState();

            // Apply line-through visual indicator
            const listItem = cb.closest('li');
            if (listItem) {
                if (cb.checked) {
                    listItem.classList.add('task-completed');
                } else {
                    listItem.classList.remove('task-completed');
                }
            }
        });

        // Initialize strike-through state on first render
        const listItem = cb.closest('li');
        if (listItem && cb.checked) {
            listItem.classList.add('task-completed');
        }
    });
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

function toggleChatControls(disabled) {
    input.disabled = disabled;
    button.disabled = disabled;
}

button.addEventListener("click", async () => {
    const userMessage = input.value.trim();
    if (!userMessage) return;

    const activeChat = chats.find(c => c.id === activeChatId);
    if (!activeChat) return;

    // 1. Clear input field & disable UI controls while processing
    input.value = "";
    toggleChatControls(true);

    // 2. Push user message to active thread & UI
    addMessageToBox("You", userMessage, true);
    activeChat.messages.push({ role: "user", content: userMessage });

    // 3. Inject current sidebar checklist status into context payload
    let backendMessage = userMessage;
    if (activeChat.checklist && activeChat.checklist.length > 0) {
        const checklistStr = activeChat.checklist
            .map(item => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
            .join('\n');
        backendMessage += `\n\n[System Note - Current Sidebar Checklist Status:\n${checklistStr}]`;
    }

    // 4. Create streaming message element for assistant
    const streamSpan = addMessageToBox("VisaPilot", "", false);
    let assistantResponse = "";

    try {
        const useWebSearch = document.getElementById('web-search-toggle')?.checked || false;

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: backendMessage,
                chat_history: activeChat.messages.slice(0, -1), // Send history up to previous message
                use_web_search: useWebSearch
            })
        });

        if (!response.ok) {
            throw new Error(`Server status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        // 5. Read streamed tokens
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            assistantResponse += chunk;

            // Temporarily mask XML tags during stream to prevent raw code from showing in the chat bubble
            let displayResponse = assistantResponse.replace(
                /<checklist>[\s\S]*?(<\/checklist>|$)/gi, 
                "\n\n*📋 Updating your right sidebar checklist...*"
            );
            
            streamSpan.innerHTML = marked.parse(displayResponse);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        // 6. Extract <checklist> block, parse items, and transfer to sidebar
        const checklistMatch = assistantResponse.match(/<checklist>([\s\S]*?)<\/checklist>/i);
        if (checklistMatch) {
            const listContent = checklistMatch[1];
            if (!activeChat.checklist) activeChat.checklist = [];

            // Regex match markdown tasks: "- [ ] Task name" or "- [x] Task name"
            const itemRegex = /- \[( |x|X)\] (.*)/g;
            let itemMatch;

            while ((itemMatch = itemRegex.exec(listContent)) !== null) {
                const isChecked = itemMatch[1].toLowerCase() === 'x';
                const text = itemMatch[2].trim();

                // Add unique items to the sidebar list
                const existingIndex = activeChat.checklist.findIndex(i => i.text === text);
                if (existingIndex === -1) {
                    activeChat.checklist.push({ text: text, checked: isChecked });
                }
            }

            // Cleanly replace raw XML block with a friendly note in chat bubble
            assistantResponse = assistantResponse.replace(
                /<checklist>[\s\S]*?<\/checklist>/i, 
                "\n\n*📋 I have updated your tracking checklist in the right sidebar.*"
            ).trim();
        }

        // 7. Save final assistant message to chat history
        activeChat.messages.push({ role: "assistant", content: assistantResponse });
        saveState();

        // 8. Re-render both chat thread & right sidebar UI
        renderActiveChatMessages();
        renderSidebarChecklist();

    } catch (error) {
        console.error("Chat API Error:", error);
        const errAlert = "\n\n[Failed to stream response. Please ensure your FastAPI backend is active.]";
        streamSpan.innerHTML = marked.parse(errAlert);
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

    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);
    uploadStatus.textContent = isImage ? `Analyzing ${file.name} with Vision Model...` : `Uploading and parsing ${file.name}...`;
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

            // Inject analysis directly into the active conversation thread
            const activeChat = chats.find(c => c.id === activeChatId);
            if (activeChat) {
                const reportContent = data.analysis 
                    ? `📄 **Extracted Document Analysis (${file.name}):**\n\n${data.analysis}`
                    : `✅ Document **${file.name}** has been uploaded and indexed successfully into memory.`;
                
                activeChat.messages.push({ role: "assistant", content: reportContent });
                saveState();
                renderActiveChatMessages();
            }
        } else {
            uploadStatus.textContent = data.error || "Upload failed";
            uploadStatus.style.color = 'red';
        }
    } catch (error) {
        console.error("Upload Error:", error);
        uploadStatus.textContent = "Error connecting to server during processing.";
        uploadStatus.style.color = 'red';
    } finally {
        uploadBtn.disabled = false;
    }
});

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
            fileInput.value = '';
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


function renderSidebarChecklist() {
    const sidebarContainer = document.getElementById('checklist-items');
    if (!sidebarContainer) return;
    
    const activeChat = chats.find(c => c.id === activeChatId);
    sidebarContainer.innerHTML = '';
    
    if (!activeChat || !activeChat.checklist || activeChat.checklist.length === 0) {
        sidebarContainer.innerHTML = '<p style="color: #666; font-size: 0.9em;">No checklist generated yet. Ask VisaPilot for a step-by-step checklist!</p>';
        return;
    }

    activeChat.checklist.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `sidebar-task-item ${item.checked ? 'sidebar-task-completed' : ''}`;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.checked;
        checkbox.id = `sidebar-cb-${index}`;
        
        checkbox.addEventListener('change', (e) => {
            activeChat.checklist[index].checked = e.target.checked;
            saveState();
            renderSidebarChecklist(); // Re-render to show strikethrough
        });

        const label = document.createElement('label');
        label.htmlFor = `sidebar-cb-${index}`;
        label.textContent = item.text;

        div.appendChild(checkbox);
        div.appendChild(label);
        sidebarContainer.appendChild(div);
    });
}


if (clearMemoryBtn) {
    clearMemoryBtn.addEventListener("click", async () => {
        const activeChat = chats.find(c => c.id === activeChatId);
        if (!activeChat) return;

        // Confirm action
        const confirmed = confirm("Are you sure you want to clear the conversation memory?\n\nThis will reset chat context, but all your uploaded documents/files will remain active!");
        if (!confirmed) return;

        try {
            // 1. Send request to clear backend Mem0 context
            await fetch("/api/clear-memory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: activeChat.id })
            });

            // 2. Wipe messages history, but PRESERVE uploaded_files & checklist
            activeChat.messages = [];
            saveState();

            // 3. Refresh chat display
            renderActiveChatMessages();

            // 4. Render system confirmation message in chat
            addMessageToBox(
                "VisaPilot", 
                "🧹 **Conversation memory has been cleared.** All uploaded files remain active in the workspace context for your next question!", 
                false
            );

        } catch (error) {
            console.error("Error clearing chat memory:", error);
            alert("Failed to clear backend memory. Please check console logs.");
        }
    });
}