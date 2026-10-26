// The part of sherpa-onnx-node that transcripts use besides the speech model (the voice
// feature declares the rest of the module; the two declarations merge).
declare module "sherpa-onnx-node" {
  export class Vad {
    constructor(
      config: {
        sileroVad: {
          model: string;
          threshold: number;
          minSilenceDuration: number;
          minSpeechDuration: number;
          windowSize: number;
          maxSpeechDuration: number;
        };
        sampleRate: number;
        numThreads: number;
        provider: string;
        debug: number;
      },
      bufferSizeInSeconds: number,
    );
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    // `start` is a sample index in everything fed so far.
    front(external?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
  }

  export class OfflineSpeakerDiarization {
    constructor(config: {
      segmentation: { pyannote: { model: string }; numThreads: number; debug: number };
      embedding: { model: string; numThreads: number; debug: number };
      clustering: { numClusters: number; threshold: number };
      minDurationOn: number;
      minDurationOff: number;
    });
    readonly sampleRate: number;
    process(samples: Float32Array): { start: number; end: number; speaker: number }[];
  }

  type EmbeddingStream = {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  };
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; debug: number; provider: string });
    createStream(): EmbeddingStream;
    isReady(stream: EmbeddingStream): boolean;
    compute(stream: EmbeddingStream, external?: boolean): Float32Array;
  }
}
