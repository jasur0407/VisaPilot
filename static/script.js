const input = document.getElementById("message-input");
const button = document.getElementById("send-btn");
const chatBox = document.getElementById("chat-box");

button.addEventListener("click", () => {

    const message = input.value.trim();

    if(message === "")
        return;

    const div = document.createElement("div");

    div.textContent = "You: " + message;

    chatBox.appendChild(div);

    input.value = "";

});