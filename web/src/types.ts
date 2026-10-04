export interface Product {
  product_id: number;
  title: string;
  category: string;
  price: number | null;
  in_stock: boolean | null;
  stock_qty: number | null;
  rating: number | null;
  url: string;
  extra?: Record<string, string | number | boolean | null>;
}

export interface Source {
  id: string;
  label: string;
  url: string;
  live: boolean;
  currency: string;
  columns: string[];
}

export interface Category {
  category: string;
  products: number;
  avg_price: number;
  min_price: number;
  max_price: number;
  avg_rating: number;
  pct_in_stock: number;
  total_stock: number;
}

export interface Change {
  product_id: number;
  title: string;
  category: string;
  old_price: number;
  new_price: number;
  pct_change: number;
  changed_at: string;
  is_simulated: boolean;
}

export interface Run {
  run_id: number;
  source: string;
  started_at: string;
  finished_at: string;
  status: string;
  rows_extracted: number;
  rows_loaded: number;
  rows_rejected: number;
  is_simulated: boolean;
  error_message: string | null;
  duration_s: number;
}

export interface Data {
  generated_at: string;
  source: Source;
  products: Product[];
  categories: Category[];
  price_index: { t: string; avg_price: number; pct_in_stock: number; products: number }[];
  changes: Change[];
  history: { product_id: number; t: string; price: number }[];
  runs: Run[];
  quality: { run_id: number; source: string; check_name: string; status: string; severity: string; details: string }[];
  rejected: { run_id: number; source: string; record_key: string; reason: string }[];
  quotes: { count: number; sample: { text: string; author: string; tags: string }[] };
}
