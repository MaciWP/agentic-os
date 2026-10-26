// The part of sherpa-onnx-node the voice worker uses; the package ships no types.
declare module "sherpa-onnx-node" {
  type OfflineStream = {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
  };
  export class OfflineRecognizer {
    constructor(config: {
      featConfig: { sampleRate: number; featureDim: number };
      modelConfig: {
        transducer?: { encoder: string; decoder: string; joiner: string };
        canary?: {
          encoder: string;
          decoder: string;
          srcLang: string;
          tgtLang: string;
          usePnc: number;
        };
        qwen3Asr?: {
          convFrontend: string;
          encoder: string;
          decoder: string;
          tokenizer: string;
          hotwords?: string;
        };
        tokens: string;
        modelType?: string;
        numThreads: number;
        provider: string;
        debug: number;
      };
      decodingMethod?: "greedy_search" | "modified_beam_search";
      maxActivePaths?: number;
      hotwordsScore?: number;
    });
    // `hotwords`: this stream's boosted terms, as model tokens (transducers only).
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text: string };
  }
}
