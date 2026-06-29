import api from './axios';
import { Template } from '../types';

export const templateApi = {
  create: (data: FormData) =>
    api.post<Template>('/templates', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  getAll: () => api.get<Template[]>('/templates'),

  getOne: (id: string) => api.get<Template>(`/templates/${id}`),

  update: (id: string, data: FormData) =>
    api.put<Template>(`/templates/${id}`, data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  delete: (id: string) => api.delete(`/templates/${id}`),

  sendTest: (id: string, testEmail: string, senderEmail?: string) =>
    api.post(`/templates/${id}/test`, { testEmail, senderEmail }),
};
