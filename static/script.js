const input = document.getElementById("message-input");
const button = document.getElementById("send-btn");
const chatBox = document.getElementById("chat-box");

function addMessage(sender, text="") {
    const div = document.createElement("div")
    div.innerHTML  = `<strong>${sender}</strong> <span>${text}</span>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight

    return div.querySelector("span")
}

button.addEventListener("click", async () => {

    const message = input.value.trim();

    if(message === "")
        return;

    addMessage("You", message)

    input.value = "";


    try {
            const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: message
            })
        });

        if (!response.ok) {
            throw new Error("Network response err")
        }

        const reader = response.body.getReader()

        const decoder = new TextDecoder()

        const aiMessageElement = addMessage("AI", "")

        while (true) {
            const {done, value} = await reader.read()

            if (done) {
                break
            }
            
            const chunk = decoder.decode(value, {stream: true})
            aiMessageElement.textContent += chunk

            chatBox.scrollTop = chatBox.scrollHeight
        }

    } catch(error) {
        console.error("Error:", error)
        addMessage("System", "Failed to connect")
    }

});


const fileInput = document.getElementById("file-input")
const uploadBtn = document.getElementById("upload-btn")
const uploadStatus = document.getElementById("upload-status")

uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0]

    if (!file) {
        uploadStatus.textContent = "Please select a file first"
        uploadStatus.style.color = 'red'
        return
    }

    uploadStatus.textContent = `Uploading and reading ${file.name}... This might take some time`
    uploadStatus.style.color = 'blue'
    uploadBtn.disabled = true

    const formData = new FormData()
    formData.append('file', file)

    try {
        const response = await fetch("/api/upload", {
            method: "POST",
            body: formData
        })

        const data = await response.json()

        if (response.ok) {
            uploadStatus.textContent = data.message
            uploadStatus.style.color = 'green'
            fileInput.value = ''
        } else {
            uploadStatus.textContent = data.error || "Upload failed";
            uploadStatus.style.color = 'red'
        }
    } catch (error) {
        console.error("Upload error:", error)
        uploadStatus.textContent = "Server error"
        uploadStatus.style.color = 'red'
    } finally {
        uploadBtn.disabled = false
    }
})