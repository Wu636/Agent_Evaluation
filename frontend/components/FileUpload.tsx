"use client";

import React, { useRef, useState, useEffect } from 'react';
import { Upload, FileText, X, Check, FileCode, AlertCircle, Type } from 'lucide-react';
import clsx from 'clsx';

interface FileUploadProps {
    label: string;
    accept: string;
    onChange: (file: File | null) => void;
    description: string;
    stepNumber: number;
    currentFile?: File | null;
}

type InputMode = 'file' | 'text';

export function FileUpload({ label, accept, onChange, description, stepNumber, currentFile }: FileUploadProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [inputMode, setInputMode] = useState<InputMode>('file');
    const [textContent, setTextContent] = useState('');
    const [fileSource, setFileSource] = useState<'file' | 'text' | null>(null); // Track where file came from
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (currentFile !== undefined) {
            setFile(currentFile);
        }
    }, [currentFile]);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const validateFile = (file: File) => {
        if (accept.includes('.json')) {
            if (!file.name.endsWith('.json') && !file.name.endsWith('.txt')) {
                return '请上传 .json 或 .txt 文件';
            }
        }
        if ((accept.includes('.docx') || accept.includes('.doc')) &&
            !file.name.endsWith('.doc') && !file.name.endsWith('.docx') && !file.name.endsWith('.md')) {
            return '请上传 .doc, .docx 或 .md 文件';
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
                setFileSource(null);
                onChange(null);
            } else {
                setError(null);
                setFile(droppedFile);
                setFileSource('file');
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
                setFileSource(null);
                onChange(null);
            } else {
                setError(null);
                setFile(selectedFile);
                setFileSource('file');
                onChange(selectedFile);
            }
        }
    };

    const handleTextSubmit = () => {
        if (!textContent.trim()) {
            setError('请输入内容');
            return;
        }

        // Create a File object from text content
        const fileName = accept.includes('.json') ? 'pasted-content.txt' : 'pasted-content.md';
        const blob = new Blob([textContent], { type: 'text/plain' });
        const textFile = new File([blob], fileName, { type: 'text/plain' });

        setError(null);
        setFile(textFile);
        setFileSource('text');
        onChange(textFile);
    };

    const clearFile = () => {
        setFile(null);
        setError(null);
        setTextContent('');
        setFileSource(null);
        onChange(null);
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };

    const switchMode = (mode: InputMode) => {
        setInputMode(mode);
        setError(null);
        // Don't clear file when switching modes
    };

    return (
        <div className={clsx(
            "relative group rounded-3xl p-1 transition-all duration-300",
            isDragging ? "bg-indigo-500 scale-[1.02]" : "hover:bg-indigo-50"
        )}>

            {/* Step Indicator */}
            <div className="absolute -top-3 -left-3 w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold shadow-lg z-10 border-2 border-white">
                {stepNumber}
            </div>

            {/* Mode Toggle */}
            <div className="absolute -top-3 right-4 flex bg-white rounded-full shadow-md border border-slate-200 overflow-hidden z-10">
                <button
                    onClick={() => switchMode('file')}
                    className={clsx(
                        "px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5",
                        inputMode === 'file' ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                    )}
                >
                    <Upload className="w-3.5 h-3.5" />
                    文件
                </button>
                <button
                    onClick={() => switchMode('text')}
                    className={clsx(
                        "px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5",
                        inputMode === 'text' ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                    )}
                >
                    <Type className="w-3.5 h-3.5" />
                    文本
                </button>
            </div>

            <div
                className={clsx(
                    "w-full border-2 border-dashed rounded-[22px] transition-all bg-white relative overflow-hidden",
                    isDragging ? "border-white bg-indigo-50" :
                        error ? "border-red-300 bg-red-50" :
                            file ? "border-emerald-300 bg-emerald-50" :
                                "border-slate-200",
                    inputMode === 'text' ? "min-h-[250px]" : file ? "min-h-[220px]" : "h-48"
                )}
                onDragOver={inputMode === 'file' ? handleDragOver : undefined}
                onDragLeave={inputMode === 'file' ? handleDragLeave : undefined}
                onDrop={inputMode === 'file' ? handleDrop : undefined}
            >
                {inputMode === 'file' ? (
                    <>
                        <input
                            ref={inputRef}
                            type="file"
                            accept={accept}
                            onChange={handleChange}
                            className="hidden"
                        />

                        {file ? (
                            <div className="text-center p-6 animate-in zoom-in duration-300 w-full">
                                <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-sm">
                                    <Check className="w-8 h-8 text-emerald-600" />
                                </div>
                                <p className="font-bold text-slate-800 text-lg mb-1 truncate px-4">{file.name}</p>
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
                    </>
                ) : (
                    <div className="p-6">
                        {file && fileSource === 'text' ? (
                            <div className="text-center animate-in zoom-in duration-300">
                                <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-sm">
                                    <Check className="w-8 h-8 text-emerald-600" />
                                </div>
                                <p className="font-bold text-slate-800 text-lg mb-1">文本已输入</p>
                                <p className="text-emerald-600 text-sm font-medium mb-2">Ready to process</p>
                                <p className="text-xs text-slate-500 mb-4">{textContent.length} 字符</p>
                                <button
                                    onClick={clearFile}
                                    className="px-4 py-2 bg-white text-slate-600 text-sm font-bold rounded-xl border border-slate-200 hover:bg-slate-50 hover:text-red-500 hover:border-red-200 transition-all flex items-center gap-2 mx-auto shadow-sm"
                                >
                                    <X className="w-4 h-4" />
                                    清除内容
                                </button>
                            </div>
                        ) : (
                            <>
                                <h3 className="font-bold text-slate-700 text-sm mb-2 uppercase tracking-wide">
                                    {label}
                                </h3>
                                <textarea
                                    value={textContent}
                                    onChange={(e) => setTextContent(e.target.value)}
                                    placeholder={accept.includes('.json') ? '粘贴对话记录 JSON 或文本...' : '粘贴教师文档内容...'}
                                    className="w-full h-32 p-3 border border-slate-200 rounded-xl resize-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm"
                                />
                                {error && (
                                    <div className="mt-2 flex items-center gap-2 text-red-500 text-sm bg-red-50 px-3 py-2 rounded-lg">
                                        <AlertCircle className="w-4 h-4" />
                                        {error}
                                    </div>
                                )}
                                <button
                                    onClick={handleTextSubmit}
                                    disabled={!textContent.trim()}
                                    className="mt-3 w-full px-4 py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                                >
                                    确认输入
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
