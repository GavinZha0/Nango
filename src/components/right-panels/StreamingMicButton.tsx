import { Mic, MicOff } from "lucide-react";
import { useStreamingASR } from "@/lib/voice/useStreamingASR";
import { cn } from "@/lib/utils";
interface StreamingMicButtonProps {
  className?: string;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

export function StreamingMicButton({ 
  className, 
  getUserMedia 
}: StreamingMicButtonProps) {
  const { isRecording, startRecording, stopRecording } = useStreamingASR({
    getUserMedia,
  });

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Render purely as an icon, absolutely positioned on the right side over the hidden native mic
  return (
    <button
      type="button"
      onClick={toggleRecording}
      className={cn(
        "streaming-mic-button absolute right-[3.5rem] bottom-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 cursor-pointer",
        isRecording 
          ? "bg-red-500/20 text-red-600 hover:bg-red-500/30 dark:text-red-400" 
          : "bg-purple-500/10 text-purple-700 hover:bg-purple-500/20 dark:text-purple-300 dark:hover:bg-purple-500/30",
        className
      )}
    >
      {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}
