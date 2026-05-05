export type FieldStatus = {
  titleNa: boolean;
  priceNa: boolean;
  ratingNa: boolean;
};

export type ProgressEvent = {
  type: 'progress';
  stage: string;
  message?: string;
  platform?: string;
  attempt?: number;
  maxAttempts?: number;
  fields?: FieldStatus;
};

export type DoneEvent = {
  type: 'done';
  result: ScrapeResult;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
  statusCode?: number;
};

export type StreamLine = ProgressEvent | DoneEvent | ErrorEvent;

export type ScrapeResult = {
  platform: string;
  title: string;
  price: string;
  rating: string;
  availability: string;
  offers: string[];
  details: Record<string, string>;
};

export type StepKey = 'detect' | 'scrape' | 'parse' | 'enrich' | 'finalize';

export type StepState = 'pending' | 'active' | 'done' | 'warn' | 'err';
