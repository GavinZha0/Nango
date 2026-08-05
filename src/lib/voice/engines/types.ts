export interface StreamingASREngine {
  /**
   * Connect to the streaming ASR backend and begin sending audio.
   * @param url The WebSocket or WebRTC URL to connect to.
   * @param stream The user's MediaStream (microphone).
   * @param onResult Callback fired when transcription is received.
   * @param onError Callback fired when an error occurs.
   * @param onClose Callback fired when the connection is closed.
   */
  start(
    url: string,
    stream: MediaStream,
    onResult: (text: string, isFinal: boolean) => void,
    onError: (error: Error | Event) => void,
    onClose: () => void
  ): Promise<void>;

  /**
   * Disconnect and clean up resources (e.g. close WebSockets, AudioContexts).
   */
  stop(): void;
}
