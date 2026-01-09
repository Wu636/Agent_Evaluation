import React from 'react';
import ReactMarkdown from 'react-markdown';

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
    return (
        <div className={`prose prose-slate prose-sm max-w-none 
            prose-p:leading-relaxed prose-p:my-2
            prose-headings:font-bold prose-headings:text-slate-800 
            prose-h4:text-base prose-h4:mt-4 prose-h4:mb-2
            prose-ul:my-2 prose-li:my-0.5
            prose-strong:text-slate-700 prose-strong:font-semibold
            ${className}`}>
            <ReactMarkdown>
                {content}
            </ReactMarkdown>
        </div>
    );
}
