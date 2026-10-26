export type ReportProgress = (update: {
  completed: number;
  total: number;
  message: string;
}) => void;
