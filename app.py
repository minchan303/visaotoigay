import streamlit as st
import os
import pydot
from PIL import Image
from io import BytesIO
from google import genai
from dotenv import load_dotenv
import requests
import tempfile

# 1. Cấu hình AI và Thiết lập Cơ bản
load_dotenv()
try:
    # Lấy API Key từ biến môi trường
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
    client = genai.Client(api_key=GEMINI_API_KEY)
    model = "gemini-2.5-flash"
except:
    st.error("Lỗi: Không tìm thấy GEMINI_API_KEY. Vui lòng kiểm tra file .env.")

# 2. Xử lý Trích xuất Nội dung (Đơn giản)
def extract_content(uploaded_file, text_input, url_input):
    content = ""
    # Ưu tiên File, sau đó là Text, cuối cùng là URL
    if uploaded_file:
        content = uploaded_file.read().decode("utf-8")
        st.session_state['source'] = "File tải lên"
    elif text_input:
        content = text_input
        st.session_state['source'] = "Văn bản dán"
    elif url_input:
        try:
            response = requests.get(url_input)
            response.raise_for_status() # Báo lỗi nếu mã trạng thái không phải 200
            # Giả định đơn giản: chỉ lấy text từ response
            # Trong thực tế cần dùng thư viện như BeautifulSoup để trích xuất sạch
            content = response.text[:5000] # Giới hạn 5000 ký tự đầu tiên
            st.session_state['source'] = f"URL: {url_input}"
        except Exception as e:
            st.error(f"Lỗi khi truy cập URL: {e}")
            return None
    
    if len(content) < 50:
         st.warning("Vui lòng cung cấp nội dung có độ dài hợp lý để phân tích.")
         return None
         
    return content

# 3. Hàm gọi Gemini (với System Instruction để định hướng chatbot)
def call_gemini(prompt):
    system_instruction = (
        "Bạn là Trợ lý Học tập AI, chuyên tóm tắt bài học, trả lời câu hỏi và tạo Mindmap. "
        "Hãy luôn trả lời dựa trên nội dung bạn được cung cấp."
    )
    
    response = client.models.generate_content(
        model=model,
        contents=[{"role": "user", "parts": [{"text": prompt}]}],
        config={"system_instruction": system_instruction}
    )
    return response.text

# 4. Hàm Tạo Mindmap (Sử dụng Graphviz)
def generate_mindmap_dot(summary_text):
    # Prompt yêu cầu Gemini tạo định dạng DOT cho Graphviz
    prompt = (
        f"Dựa trên tóm tắt sau, hãy tạo một mã nguồn Graphviz DOT hợp lệ. "
        f"Sử dụng kiểu dáng (graph style) Mindmap: Nút chính là hình bầu dục, nút phụ là hình chữ nhật, mũi tên đơn giản, font chữ hiện đại. "
        f"Chỉ trả lời bằng mã DOT, không thêm bất kỳ văn bản giải thích nào.\n\n"
        f"Nội dung cần xử lý:\n{summary_text}"
    )
    
    dot_code = call_gemini(prompt)
    
    # Đảm bảo mã DOT bắt đầu bằng 'digraph' hoặc 'graph'
    if 'digraph' not in dot_code and 'graph' not in dot_code:
        st.warning("AI không trả về mã DOT hợp lệ. Thử lại hoặc tóm tắt lại.")
        return None
    
    # Lưu mã DOT vào một tệp tạm thời và tạo đồ thị
    try:
        graph = pydot.graph_from_dot_data(dot_code)[0]
        temp_file = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        graph.write_png(temp_file.name)
        return temp_file.name
    except Exception as e:
        st.error(f"Lỗi khi xử lý Graphviz: {e}. Mã DOT được tạo:\n{dot_code}")
        return None

# 5. Thiết lập Giao diện Streamlit
st.set_page_config(layout="wide", page_title="AI Learning Assistant")

# Sử dụng CSS tùy chỉnh để làm giao diện bắt mắt hơn (phông chữ, màu sắc)
st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
    
    body {
        font-family: 'Roboto', sans-serif;
    }
    .stApp {
        background-color: #f0f2f6;
    }
    .main-header {
        color: #1E90FF;
        font-weight: 700;
        text-align: center;
        margin-bottom: 20px;
    }
    .stTextArea, .stTextInput {
        border-radius: 10px;
    }
    .stButton>button {
        background-color: #1E90FF;
        color: white;
        border-radius: 8px;
        padding: 10px 20px;
    }
    .chat-container {
        border: 1px solid #ccc;
        border-radius: 10px;
        padding: 15px;
        background-color: white;
        min-height: 200px;
    }
</style>
""", unsafe_allow_html=True)

st.markdown('<h1 class="main-header">🧠 Trợ Lý Học Tập AI Gemini 🚀</h1>', unsafe_allow_html=True)

# 6. Sidebar (Nhập liệu)
with st.sidebar:
    st.header("1. Cung cấp Nội dung Học tập")
    
    # Input File
    uploaded_file = st.file_uploader("Tải lên File (TXT, PDF cơ bản)", type=['txt', 'pdf', 'docx'])
    st.markdown("---")

    # Input Text
    text_input = st.text_area("Hoặc dán văn bản bài học vào đây:", height=200)
    st.markdown("---")
    
    # Input URL
    url_input = st.text_input("Hoặc nhập URL của bài viết/trang web:", placeholder="https://example.com/bai-hoc")
    st.markdown("---")
    
    if st.button("Phân tích Nội dung Chính"):
        content = extract_content(uploaded_file, text_input, url_input)
        if content:
            st.session_state['lesson_content'] = content
            st.session_state['content_loaded'] = True
            st.success(f"Đã tải và trích xuất nội dung từ {st.session_state.get('source', 'nguồn chưa xác định')}. Độ dài: {len(content)} ký tự.")
        else:
            st.session_state['content_loaded'] = False
            st.error("Chưa có nội dung hợp lệ để phân tích.")

# 7. Main Panel (Hiển thị Tính năng)
if 'content_loaded' not in st.session_state or not st.session_state['content_loaded']:
    st.info("Vui lòng cung cấp nội dung học tập ở Sidebar để bắt đầu phân tích!")
else:
    # Lựa chọn tính năng
    tab_summarize, tab_mindmap, tab_qa = st.tabs(["📝 Tóm tắt Bài học", "🗺️ Tạo Mindmap", "💬 Hỏi & Đáp (Q&A)"])
    
    # --- TÓM TẮT ---
    with tab_summarize:
        st.header("Tóm tắt và Ghi chú nhanh")
        if st.button("Bắt đầu Tóm tắt"):
            with st.spinner("AI đang phân tích và tóm tắt nội dung..."):
                prompt = f"Tóm tắt nội dung sau thành 5-7 gạch đầu dòng quan trọng nhất, tập trung vào định nghĩa, công thức/nguyên tắc chính, và kết luận. Văn bản:\n\n{st.session_state['lesson_content']}"
                summary = call_gemini(prompt)
                st.session_state['summary'] = summary
                st.success("Tóm tắt hoàn tất:")
                st.markdown(summary)

    # --- MINDMAP ---
    with tab_mindmap:
        st.header("Chuyển Bài học thành Sơ đồ Tư duy")
        st.info("Chức năng này cần mô hình AI tạo mã đồ họa, có thể mất vài giây.")
        
        if st.button("Tạo Mindmap Dạng Hình ảnh"):
            if 'summary' not in st.session_state:
                st.warning("Vui lòng tóm tắt bài học trước (Tab 1) để có cơ sở tạo Mindmap.")
            else:
                with st.spinner("AI đang tạo mã đồ họa và render hình ảnh..."):
                    # 1. Tạo mã DOT
                    temp_png_path = generate_mindmap_dot(st.session_state['summary'])
                    
                    # 2. Hiển thị Mindmap
                    if temp_png_path:
                        st.image(temp_png_path, caption="Sơ đồ Tư duy (Mindmap) của Bài học", use_column_width=True)
                        st.success("Đã tạo Mindmap thành công!")
                        # Xóa file tạm thời
                        os.remove(temp_png_path)
    
    # --- Q&A CHATBOT ---
    with tab_qa:
        st.header("Hỏi & Đáp về Bài học")
        st.markdown('<div class="chat-container">', unsafe_allow_html=True)
        
        # Hiển thị lịch sử chat
        if "messages" not in st.session_state:
            st.session_state["messages"] = [{"role": "assistant", "content": "Chào bạn! Hãy hỏi tôi bất kỳ điều gì về nội dung bài học đã tải lên."}]

        for message in st.session_state.messages:
            with st.chat_message(message["role"]):
                st.markdown(message["content"])

        # Input của người dùng
        if prompt := st.chat_input("Hỏi tôi về một khái niệm, công thức..."):
            st.session_state.messages.append({"role": "user", "content": prompt})
            with st.chat_message("user"):
                st.markdown(prompt)

            with st.chat_message("assistant"):
                with st.spinner("Đang tìm kiếm thông tin trong bài học..."):
                    # Gộp nội dung bài học và câu hỏi để Gemini trả lời
                    full_prompt = (
                        f"Dựa trên nội dung bài học sau, trả lời câu hỏi của người dùng. "
                        f"Nội dung: {st.session_state['lesson_content']}\n\n"
                        f"Câu hỏi của người dùng: {prompt}"
                    )
                    ai_response = call_gemini(full_prompt)
                    st.markdown(ai_response)
            
            st.session_state.messages.append({"role": "assistant", "content": ai_response})
            
        st.markdown('</div>', unsafe_allow_html=True)