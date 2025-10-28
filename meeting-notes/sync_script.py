import os
import io
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from git import Repo
from git.exc import GitCommandError

# --- 配置 ---
# 环境变量来自 GitHub Actions
DOC_ID = os.environ.get('DOC_FILE_ID')
TARGET_FILE_PATH = os.environ.get('TARGET_FILE_PATH')

# --- Google Docs API 认证与下载 ---
def download_markdown_from_drive(doc_id):
    SCOPES = ['[https://www.googleapis.com/auth/drive.readonly](https://www.googleapis.com/auth/drive.readonly)']
    SERVICE_ACCOUNT_FILE = 'service_account.json'

    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=SCOPES)
    
    # 构建 Drive API 客户端
    service = build('drive', 'v3', credentials=creds)

    # Docs/Drive API 的导出 MIME 类型：'text/markdown'
    request = service.files().export_media(
        fileId=doc_id, 
        mimeType='text/markdown'
    )
    
    # 使用 BytesIO 接收文档内容
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while done is False:
        status, done = downloader.next_chunk()
        # 打印下载进度 (可选)
        # print(f"Download {int(status.progress() * 100)}%.")

    # 返回字节内容，确保编码为 UTF-8
    # 相比 Apps Script 字符串，Python 的 bytes.decode('utf-8') 更加可靠
    return fh.getvalue().decode('utf-8')

# --- Git 操作：文档写入和暂存 ---
def write_and_stage_file(content):
    # 确保目标目录存在
    os.makedirs(os.path.dirname(TARGET_FILE_PATH), exist_ok=True)
    
    # 写入文档，使用 utf-8 编码
    with open(TARGET_FILE_PATH, 'w', encoding='utf-8') as f:
        f.write(content)

    # 初始化 Git 仓库对象
    repo = Repo('.')
    # 暂存更改
    repo.index.add([TARGET_FILE_PATH])
    print(f"File {TARGET_FILE_PATH} written and staged successfully.")

# --- 主执行流程 ---
if __name__ == '__main__':
    try:
        # 1. 从 Google Drive 下载 Markdown 内容
        markdown_content = download_markdown_from_drive(DOC_ID)
        
        # 2. 将内容写入本地工作目录并暂存
        write_and_stage_file(markdown_content)
        
    except Exception as e:
        print(f"An error occurred during sync: {e}")
        exit(1)