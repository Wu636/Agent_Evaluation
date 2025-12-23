"use client";

import React, { useRef, useState } from 'react';
import { Upload, FileText, X, Check, FileCode, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

interface FileUploadProps {
    label: string;
    accept: string;
    onChange: (file: File | null) => void;
    description: string;
    stepNumber: number;
}

export function FileUpload({ label, accept, onChange, description, stepNumber }: FileUploadProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const validateFile = (file: File) => {
        // Accept both .json and .txt for dialogue records
        if (accept.includes('.json')) {
            if (!file.name.endsWith('.json') && !file.name.endsWith('.txt')) {
                return '请上传 .json 或 .txt 文件';
            }
        }
        if ((accept === '.docx,.md' || accept.includes('.docx')) &&
            !file.name.endsWith('.docx') && !file.name.endsWith('.md')) {
            return '请上传 .docx 或 .md 文件';
        }
        return null;
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const droppedFile = e.dataTransfer.files[0];
            const validationError = validateFile(droppedFile);

            if (validationError) {
                setError(validationError);
                setFile(null);
                onChange(null);
            } else {
                setError(null);
                setFile(droppedFile);
                onChange(droppedFile);
            }
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const selectedFile = e.target.files[0];
            const validationError = validateFile(selectedFile);

            if (validationError) {
                setError(validationError);
                setFile(null);
                onChange(null);
            } else {
                setError(null);
                setFile(selectedFile);
                onChange(selectedFile);
            }
        }
    };

    const clearFile = () => {
        setFile(null);
        setError(null);
        onChange(null);
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };

    return (
        <div className={clsx(
            "relative group rounded-3xl p-1 transition-all duration-300",
            isDragging ? "bg-indigo-500 scale-[1.02]" : "hover:bg-indigo-50"
        )}>

            {/* Step Indicator - Floating Outside */}
            <div className="absolute -top-3 -left-3 w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold shadow-lg z-10 border-2 border-white">
                {stepNumber}
            </div>

            <div
                className={clsx(
                    "w-full h-48 border-2 border-dashed rounded-[22px] flex flex-col items-center justify-center transition-all bg-white relative overflow-hidden",
                    isDragging ? "border-white bg-indigo-50" :
                        error ? "border-red-300 bg-red-50" :
                            file ? "border-emerald-300 bg-emerald-50" :
                                "border-slate-200"
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept={accept}
                    onChange={handleChange}
                    className="hidden"
                />

                {file ? (
                    <div className="text-center p-6 animate-in zoom-in duration-300">
                        <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-sm">
                            <Check className="w-8 h-8 text-emerald-600" />
                        </div>
                        <p className="font-bold text-slate-800 text-lg mb-1 truncate max-w-[250px]">{file.name}</p>
                        <p className="text-emerald-600 text-sm font-medium mb-4">Ready to process</p>
                        <button
                            onClick={(e) => { e.stopPropagation(); clearFile(); }}
                            className="px-4 py-2 bg-white text-slate-600 text-sm font-bold rounded-xl border border-slate-200 hover:bg-slate-50 hover:text-red-500 hover:border-red-200 transition-all flex items-center gap-2 mx-auto shadow-sm"
                        >
                            <X className="w-4 h-4" />
                            Remove File
                        </button>
                    </div>
                ) : (
                    <div className="text-center p-6">
                        <div className={clsx(
                            "w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 transition-transform duration-300",
                            isDragging ? "scale-110 bg-indigo-200" : "bg-indigo-50 group-hover:bg-indigo-100"
                        )}>
                            {accept.includes('.json') ? (
                                <FileCode className={clsx("w-8 h-8", isDragging ? "text-indigo-700" : "text-indigo-500")} />
                            ) : (
                                <FileText className={clsx("w-8 h-8", isDragging ? "text-indigo-700" : "text-indigo-500")} />
                            )}
                        </div>
                        <h3 className="font-bold text-slate-700 text-lg mb-1 group-hover:text-indigo-700 transition-colors uppercase tracking-wide text-xs">
                            {label}
                        </h3>
                        <p className="font-medium text-slate-500 text-sm mb-4">
                            Click to upload or drag & drop
                        </p>
                        <p className="text-xs text-slate-400 font-mono bg-slate-100 py-1 px-3 rounded-full inline-block">
                            {description}
                        </p>
                        {error && (
                            <div className="mt-4 flex items-center gap-2 text-red-500 text-sm bg-red-50 px-3 py-2 rounded-lg justify-center animate-in slide-in-from-bottom-2">
                                <AlertCircle className="w-4 h-4" />
                                {error}
                            </div>
                        )}
                    </div>
                )}

                {!file && (
                    <button
                        className="absolute inset-0 w-full h-full cursor-pointer"
                        onClick={() => inputRef.current?.click()}
                    />
                )}
            </div>
        </div>
    );
}
