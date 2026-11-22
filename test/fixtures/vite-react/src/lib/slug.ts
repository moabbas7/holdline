import { slugify } from './legacy.js';
import { motion } from 'framer-motion';

export const slug = (s: string) => slugify(s);
export { motion };
