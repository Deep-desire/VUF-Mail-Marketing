import api from './axios';
import { Upload, ContactsResponse, DashboardStats } from '../types';

export const uploadApi = {
  uploadExcel: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<Upload>('/uploads/excel', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  getAll: () => api.get<Upload[]>('/uploads'),

  getOne: (id: string) => api.get<Upload>(`/uploads/${id}`),

  getContacts: (id: string, page = 1, limit = 50) =>
    api.get<ContactsResponse>(`/uploads/${id}/contacts`, {
      params: { page, limit },
    }),

  getDashboardStats: () => api.get<DashboardStats>('/uploads/stats/dashboard'),

  startSend: (id: string, templateId: string) =>
    api.post<{ message: string }>(`/uploads/${id}/send`, { templateId }),
};
