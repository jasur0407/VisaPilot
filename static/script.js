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