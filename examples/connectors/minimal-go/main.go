package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

var (
	token = os.Getenv("SOPHON_TOKEN")
	base  = env("SOPHON_BASE", "https://api.sophon.at")
)

type Frame struct {
	Type   string `json:"type"`
	Update Update `json:"update"`
}

type Update struct {
	UpdateID      string          `json:"update_id"`
	Type          string          `json:"type"`
	SessionID     string          `json:"session_id"`
	InteractionID string          `json:"interaction_id"`
	Payload       json.RawMessage `json:"payload"`
}

type Payload struct {
	Message struct {
		Text string `json:"text"`
	} `json:"message"`
}

func main() {
	if token == "" {
		log.Fatal("SOPHON_TOKEN is required")
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL(base), http.Header{
		"Authorization": []string{"Bearer " + token},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	log.Println("Sophon Go connector connected")
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			log.Fatal(err)
		}

		var frame Frame
		if err := json.Unmarshal(raw, &frame); err != nil {
			log.Println("bad frame:", err)
			continue
		}

		switch frame.Type {
		case "ping":
			writeJSON(conn, map[string]string{"type": "pong"})
		case "update":
			writeJSON(conn, map[string]string{"type": "ack", "up_to_update_id": frame.Update.UpdateID})
			if frame.Update.Type == "session.message" {
				if err := respond(frame.Update); err != nil {
					log.Println("respond failed:", err)
				}
			}
		}
	}
}

func respond(update Update) error {
	var payload Payload
	_ = json.Unmarshal(update.Payload, &payload)
	reply := "Echo from Go connector: " + payload.Message.Text

	created, err := post("/v1/bridge/sendMessage", map[string]any{
		"session_id":      update.SessionID,
		"interaction_id":  update.InteractionID,
		"text":            "",
		"idempotency_key": update.InteractionID + ":message",
	})
	if err != nil {
		return err
	}

	messageID, _ := created["message_id"].(string)
	if messageID == "" {
		messageID, _ = created["id"].(string)
	}

	for index, delta := range chunks(reply, 24) {
		if _, err := post("/v1/bridge/sendMessageDelta", map[string]any{
			"message_id":      messageID,
			"delta":           delta,
			"idempotency_key": fmt.Sprintf("%s:delta:%d", update.InteractionID, index),
		}); err != nil {
			return err
		}
	}

	_, err = post("/v1/bridge/sendMessageEnd", map[string]any{
		"message_id":      messageID,
		"text":            reply,
		"finish_reason":   "stop",
		"idempotency_key": update.InteractionID + ":end",
	})
	return err
}

func post(path string, body map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(base, "/")+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, _ := io.ReadAll(res.Body)
	var envelope map[string]any
	_ = json.Unmarshal(data, &envelope)
	if res.StatusCode >= 400 || envelope["ok"] == false {
		return nil, fmt.Errorf("%s failed: %d %s", path, res.StatusCode, string(data))
	}

	if result, ok := envelope["result"].(map[string]any); ok {
		return result, nil
	}
	return envelope, nil
}

func writeJSON(conn *websocket.Conn, value any) {
	if err := conn.WriteJSON(value); err != nil {
		log.Println("write failed:", err)
	}
}

func wsURL(base string) string {
	base = strings.TrimRight(base, "/")
	base = strings.TrimPrefix(base, "https://")
	base = strings.TrimPrefix(base, "http://")
	if strings.HasPrefix(os.Getenv("SOPHON_BASE"), "http://") {
		return "ws://" + base + "/v1/bridge/ws"
	}
	return "wss://" + base + "/v1/bridge/ws"
}

func chunks(text string, size int) []string {
	var out []string
	for len(text) > size {
		out = append(out, text[:size])
		text = text[size:]
	}
	if text != "" {
		out = append(out, text)
	}
	return out
}

func env(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
