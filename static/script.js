const input = document.getElementById("message-input");
const button = document.getElementById("send-btn");
const chatBox = document.getElementById("chat-box");

function addMessage(sender, text) {
    const div = document.createElement("div")
    div.innerHTML  = `<strong>${sender}</strong> ${text}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight
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

        const data = await response.json()

        if (data.error) {
            addMessage("System", data.error)
        } else {
            addMessage("AI", data.answer)
        }

    } catch(error) {
        console.error("Error:", error)
        addMessage("System", "Failed to connect")
    }

});