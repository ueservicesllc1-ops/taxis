// Firebase Configuration
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, where, orderBy, updateDoc, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyC03i4R2cxyOKV4W443mPzDXQ4GBzCgrOc",
    authDomain: "superprice-fa792.firebaseapp.com",
    projectId: "superprice-fa792",
    storageBucket: "superprice-fa792.firebasestorage.app",
    messagingSenderId: "563172013263",
    appId: "1:563172013263:web:2d162dab07f2222f4233ba",
    measurementId: "G-SJF9G3N639"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();

export {
    db, auth, storage, googleProvider,
    collection, addDoc, onSnapshot, query, where, orderBy, updateDoc, doc, getDoc, setDoc,
    signInWithPopup, signInAnonymously, signOut, onAuthStateChanged,
    ref, uploadBytes, getDownloadURL
};
